//! AdGuard Home: /control/stats -> h.agh_stats (mesmas colunas do _poll_agh_once).
//! Mesmo backoff exponencial e mesma política de eventos do MikroTik.
use std::time::Duration;

use serde_json::Value;
use tokio::sync::watch;
use tracing::{debug, info, warn};

use crate::backoff::Backoff;
use crate::db::{Db, Rec};
use crate::health::{now, safe_err, sleep_until, Registry};
use crate::settings::{num, Integration, Shared};

/// Uma leitura de /control/stats.
pub async fn poll(client: &reqwest::Client, cfg: &Integration) -> Result<Rec, String> {
    let mut req = client.get(format!("{}/control/stats", cfg.base()));
    if !cfg.username.is_empty() {
        req = req.basic_auth(&cfg.username, Some(&cfg.password));
    }
    let s: Value =
        req.send().await.map_err(|e| safe_err(&e))?.error_for_status().map_err(|e| safe_err(&e))?.json().await.map_err(|e| safe_err(&e))?;
    if !s.is_object() {
        return Err("JSONDecodeError".into());
    }
    let i = |k: &str| num(s.get(k)).map(|v| v as i64).unwrap_or(0);
    Ok(Rec::Agh {
        ts: now(),
        queries: i("num_dns_queries"),
        blocked: i("num_blocked_filtering"),
        safebrowsing: i("num_replaced_safebrowsing"),
        parental: i("num_replaced_parental"),
        avg_ms: num(s.get("avg_processing_time")).unwrap_or(0.0),
    })
}

pub fn client(timeout: Duration) -> reqwest::Client {
    // o Python usa verify padrão do requests (valida certificado) para o AdGuard
    reqwest::Client::builder().timeout(timeout).connect_timeout(timeout).pool_max_idle_per_host(1).build().expect("cliente HTTP")
}

pub async fn run(db: Db, settings: watch::Receiver<Shared>, reg: Registry, max_backoff_s: f64, mut stop: watch::Receiver<bool>) {
    let client = client(Duration::from_secs(6));
    let mut bo = Backoff::new(max_backoff_s);
    let mut last_target = String::new();
    let mut was_ready = false;
    if !sleep_until(now(), || 4.0, &mut stop).await {
        return;
    }
    loop {
        let t0 = now();
        let cfg = settings.borrow().agh.clone();
        let mut err = None;
        let target = format!("{}:{}", cfg.host, cfg.port);
        if target != last_target {
            bo.ok();
            last_target = target;
        }
        if cfg.ready(false) {
            if !was_ready {
                info!("adguard: coletando de {} a cada {}s", cfg.host, cfg.interval_s);
            }
            match poll(&client, &cfg).await {
                Ok(rec) => {
                    debug!("adguard: ok");
                    let mut recs = vec![rec];
                    if let Some(n) = bo.ok() {
                        info!("adguard: voltou a responder depois de {n} falha(s)");
                        recs.push(Rec::Event {
                            ts: now(),
                            message: format!("Coleta do AdGuard Home restabelecida (após {n} tentativa(s) sem resposta)"),
                            severity: "Info",
                        });
                    }
                    db.write(recs);
                }
                Err(e) => {
                    let n = bo.fail();
                    if bo.should_report() {
                        warn!("adguard: {e} ({n}ª falha seguida; próxima tentativa em {:.0}s)", bo.delay(cfg.interval_s as f64));
                    }
                    if n == 1 {
                        db.write(vec![Rec::Event {
                            ts: now(),
                            message: format!("Falha ao coletar dados do AdGuard Home: {e}"),
                            severity: "Baixa",
                        }]);
                    }
                    err = Some(e);
                }
            }
        } else {
            bo.ok();
        }
        was_ready = cfg.ready(false);
        reg.ran("agh", cfg.interval_s as f64, err);
        let s = settings.clone();
        let wait = if bo.fails() > 0 { Some(bo.delay(cfg.interval_s as f64)) } else { None };
        if !sleep_until(t0, move || wait.unwrap_or_else(|| s.borrow().agh.interval_s as f64), &mut stop).await {
            break;
        }
    }
    info!("adguard: encerrado");
}
