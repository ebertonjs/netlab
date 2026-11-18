//! MikroTik REST (RouterOS 7): system/resource, system/health e interface.
//! Grava as mesmas linhas que o _poll_mikrotik_once do Python. A sincronização do DHCP
//! (promoção de aparelhos) continua no Python.
//!
//! Quando o roteador não responde, as tentativas seguem um backoff exponencial (intervalo × 2ⁿ até
//! `retry.max_backoff_secs`). O evento "Falha ao coletar" é gravado só na primeira falha da sequência
//! e um "restabelecida" na volta — antes era um evento por ciclo enquanto o roteador estivesse fora.
use std::collections::HashMap;
use std::time::Duration;

use serde_json::{Map, Value};
use tokio::sync::watch;
use tracing::{debug, info, warn};

use crate::backoff::Backoff;
use crate::db::{Db, Rec};
use crate::health::{now, safe_err, sleep_until, Registry};
use crate::settings::{clean_name, num, Integration, Shared};

/// "3w0d4h12m5s" -> segundos (None se vazio)
pub fn parse_uptime(t: &str) -> Option<i64> {
    if t.is_empty() {
        return None;
    }
    let (mut total, mut n) = (0i64, String::new());
    for c in t.chars() {
        if c.is_ascii_digit() {
            n.push(c);
        } else {
            let mult = match c {
                'w' => 604_800,
                'd' => 86_400,
                'h' => 3_600,
                'm' => 60,
                's' => 1,
                _ => {
                    n.clear();
                    continue;
                }
            };
            total += n.parse::<i64>().unwrap_or(0) * mult;
            n.clear();
        }
    }
    Some(total)
}

fn int(v: Option<&Value>) -> i64 {
    num(v).map(|x| x as i64).unwrap_or(0)
}

fn truthy(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::Bool(true))) || matches!(v, Some(Value::String(s)) if s == "true")
}

fn opt_str(v: Option<&Value>) -> Option<String> {
    match v {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    }
}

/// Cliente da API REST do MikroTik com o estado necessário para calcular bps (contadores anteriores).
pub struct Mt {
    secure: reqwest::Client,
    insecure: reqwest::Client,
    prev: HashMap<String, (i64, i64, f64)>,
}

impl Mt {
    pub fn new(timeout: Duration) -> Self {
        let mk = |insecure: bool| {
            reqwest::Client::builder()
                .timeout(timeout)
                .connect_timeout(timeout)
                .danger_accept_invalid_certs(insecure)
                .pool_max_idle_per_host(1)
                .build()
                .expect("cliente HTTP")
        };
        Self { secure: mk(false), insecure: mk(true), prev: HashMap::new() }
    }

    /// Esquece os contadores (ex.: troca de roteador): a próxima leitura não calcula bps.
    pub fn reset(&mut self) {
        self.prev.clear();
    }

    async fn get(&self, cfg: &Integration, path: &str) -> Result<Value, String> {
        let client = if cfg.verify_ssl { &self.secure } else { &self.insecure };
        let r = client
            .get(format!("{}/rest/{path}", cfg.base()))
            .basic_auth(&cfg.username, Some(&cfg.password))
            .send()
            .await
            .map_err(|e| safe_err(&e))?
            .error_for_status()
            .map_err(|e| safe_err(&e))?;
        r.json::<Value>().await.map_err(|e| safe_err(&e))
    }

    /// Uma coleta completa. Devolve os registros obtidos (mesmo parciais) e o erro, se houve.
    pub async fn poll(&mut self, cfg: &Integration) -> (Vec<Rec>, Option<String>) {
        let ts = now();
        let mut recs = Vec::new();
        let res = match self.get(cfg, "system/resource").await {
            Ok(Value::Array(a)) => a.into_iter().next().and_then(|v| v.as_object().cloned()).unwrap_or_default(),
            Ok(Value::Object(o)) => o,
            Ok(_) => return (recs, Some("JSONDecodeError".into())),
            Err(e) => return (recs, Some(e)),
        };
        // temperatura é opcional: erro aqui não invalida a coleta
        let mut temperature = None;
        if let Ok(h) = self.get(cfg, "system/health").await {
            let items = match h {
                Value::Array(a) => a,
                other => vec![other],
            };
            for it in items {
                if matches!(it.get("name").and_then(Value::as_str), Some("temperature" | "cpu-temperature")) {
                    temperature = num(it.get("value"));
                }
            }
        }
        recs.push(resource(ts, &res, temperature));

        let ifaces = match self.get(cfg, "interface").await {
            Ok(Value::Array(a)) => a,
            Ok(_) => return (recs, Some("JSONDecodeError".into())),
            Err(e) => return (recs, Some(e)),
        };
        let mut comments = Map::new();
        for it in ifaces {
            let Some(name) = it.get("name").and_then(Value::as_str).filter(|n| !n.is_empty()).map(str::to_string) else { continue };
            let (rx, tx) = (int(it.get("rx-byte")), int(it.get("tx-byte")));
            let (mut rx_bps, mut tx_bps) = (0.0, 0.0);
            if let Some(&(prx, ptx, pts)) = self.prev.get(&name) {
                if ts > pts {
                    let dt = ts - pts;
                    rx_bps = ((rx - prx) as f64 * 8.0 / dt).max(0.0);
                    tx_bps = ((tx - ptx) as f64 * 8.0 / dt).max(0.0);
                }
            }
            self.prev.insert(name.clone(), (rx, tx, ts));
            comments.insert(name.clone(), Value::String(clean_name(it.get("comment").and_then(Value::as_str).unwrap_or(""), 40)));
            recs.push(Rec::MtIface {
                ts,
                name,
                running: truthy(it.get("running")),
                disabled: truthy(it.get("disabled")),
                rx_bytes: rx,
                tx_bytes: tx,
                rx_bps,
                tx_bps,
            });
        }
        // comentário de cada porta (o Python mostra na página inicial)
        recs.push(Rec::Meta { key: "mt_comments".into(), value: Value::Object(comments).to_string(), ts });
        (recs, None)
    }
}

fn resource(ts: f64, r: &Map<String, Value>, temperature: Option<f64>) -> Rec {
    Rec::MtResource {
        ts,
        cpu_load: num(r.get("cpu-load")).unwrap_or(0.0),
        uptime_s: parse_uptime(r.get("uptime").and_then(Value::as_str).unwrap_or("")),
        free_memory: int(r.get("free-memory")),
        total_memory: int(r.get("total-memory")),
        free_hdd: int(r.get("free-hdd-space")),
        total_hdd: int(r.get("total-hdd-space")),
        temperature,
        board_name: opt_str(r.get("board-name")),
        version: opt_str(r.get("version")),
    }
}

pub async fn run(db: Db, settings: watch::Receiver<Shared>, reg: Registry, max_backoff_s: f64, mut stop: watch::Receiver<bool>) {
    let mut mt = Mt::new(Duration::from_secs(6));
    let mut bo = Backoff::new(max_backoff_s);
    let mut last_target = String::new();
    let mut was_ready = false;
    if !sleep_until(now(), || 3.0, &mut stop).await {
        return;
    }
    loop {
        let t0 = now();
        let cfg = settings.borrow().mikrotik.clone();
        let mut err = None;
        let target = format!("{}:{}", cfg.host, cfg.port);
        if target != last_target {
            // outro roteador/porta: recomeça do zero (contadores e backoff)
            mt.reset();
            bo.ok();
            last_target = target;
        }
        if cfg.ready(true) {
            if !was_ready {
                info!("mikrotik: coletando de {} a cada {}s", cfg.host, cfg.interval_s);
            }
            let (mut recs, e) = mt.poll(&cfg).await;
            debug!("mikrotik: {} registro(s)", recs.len());
            match &e {
                Some(msg) => {
                    let n = bo.fail();
                    if bo.should_report() {
                        warn!("mikrotik: {msg} ({n}ª falha seguida; próxima tentativa em {:.0}s)", bo.delay(cfg.interval_s as f64));
                    } else {
                        debug!("mikrotik: {msg} ({n}ª falha seguida)");
                    }
                    if n == 1 {
                        recs.push(Rec::Event {
                            ts: now(),
                            message: format!("Falha ao coletar dados do MikroTik: {msg}"),
                            severity: "Baixa",
                        });
                    }
                }
                None => {
                    if let Some(n) = bo.ok() {
                        info!("mikrotik: voltou a responder depois de {n} falha(s)");
                        recs.push(Rec::Event {
                            ts: now(),
                            message: format!("Coleta do MikroTik restabelecida (após {n} tentativa(s) sem resposta)"),
                            severity: "Info",
                        });
                    }
                }
            }
            db.write(recs);
            err = e;
        } else {
            mt.reset();
            bo.ok();
        }
        was_ready = cfg.ready(true);
        reg.ran("mikrotik", cfg.interval_s as f64, err);
        let s = settings.clone();
        let wait = if bo.fails() > 0 { Some(bo.delay(cfg.interval_s as f64)) } else { None };
        // sem falha: relê o intervalo a cada segundo (mudança na UI vale na hora); em backoff: espera fixa
        if !sleep_until(t0, move || wait.unwrap_or_else(|| s.borrow().mikrotik.interval_s as f64), &mut stop).await {
            break;
        }
    }
    info!("mikrotik: encerrado");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uptime() {
        assert_eq!(parse_uptime("3w0d4h12m"), Some(3 * 604_800 + 4 * 3600 + 12 * 60));
        assert_eq!(parse_uptime("45s"), Some(45));
        assert_eq!(parse_uptime(""), None);
    }

    #[test]
    fn recurso_como_python() {
        let v: Value = serde_json::json!({"cpu-load":"12","uptime":"1d2h","free-memory":"100","total-memory":"400",
            "free-hdd-space":"5","total-hdd-space":"10","board-name":"hAP ax^2","version":"7.16.1 (stable)"});
        match resource(1.0, v.as_object().unwrap(), Some(48.0)) {
            Rec::MtResource { cpu_load, uptime_s, free_memory, total_memory, temperature, board_name, .. } => {
                assert_eq!(cpu_load, 12.0);
                assert_eq!(uptime_s, Some(93_600));
                assert_eq!((free_memory, total_memory), (100, 400));
                assert_eq!(temperature, Some(48.0));
                assert_eq!(board_name.as_deref(), Some("hAP ax^2"));
            }
            _ => panic!(),
        }
    }
}
