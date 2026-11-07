//! Estado de cada módulo, publicado em h.meta como `collector:<módulo>` no mesmo formato
//! do worker_health() do Python (o painel "Coletores" mostra os dois lados juntos).
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::json;
use tokio::sync::watch;

use crate::db::{Db, Rec};

pub fn now() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Health {
    pub runs: u64,
    pub errors: u64,
    pub last_run: Option<f64>,
    pub last_ok: Option<f64>,
    pub error: Option<String>,
    pub error_ts: Option<f64>,
    pub interval: f64,
}

#[derive(Clone, Default)]
pub struct Registry(Arc<Mutex<BTreeMap<String, Health>>>);

impl Registry {
    pub fn ran(&self, name: &str, interval: f64, err: Option<String>) {
        let mut m = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let h = m.entry(name.to_string()).or_default();
        let t = now();
        h.runs += 1;
        h.last_run = Some(t);
        h.interval = interval;
        match err {
            Some(e) => {
                h.errors += 1;
                h.error = Some(e);
                h.error_ts = Some(t);
            }
            None => {
                h.last_ok = Some(t);
                h.error = None;
            }
        }
    }

    pub fn snapshot(&self) -> BTreeMap<String, Health> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

/// A cada 5 s grava o estado dos módulos + `collector:heartbeat`. O Python usa o heartbeat
/// para saber se o coletor está vivo (e volta a coletar sozinho se ele parar).
pub async fn heartbeat(db: Db, reg: Registry, modules: Vec<&'static str>, mut stop: watch::Receiver<bool>) {
    let started = now();
    let pid = std::process::id();
    loop {
        let t = now();
        let mut recs: Vec<Rec> = reg
            .snapshot()
            .into_iter()
            .map(|(k, h)| Rec::Meta { key: format!("collector:{k}"), value: serde_json::to_string(&h).unwrap_or_default(), ts: t })
            .collect();
        recs.push(Rec::Meta {
            key: "collector:heartbeat".into(),
            value: json!({"ts": t, "pid": pid, "version": env!("CARGO_PKG_VERSION"), "modules": modules, "started": started}).to_string(),
            ts: t,
        });
        db.write(recs);
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(5)) => {}
            _ = stop.changed() => return,
        }
    }
}

/// Mensagem curta sem URL/credencial (equivalente ao _safe_err do Python).
pub fn safe_err(e: &reqwest::Error) -> String {
    if let Some(s) = e.status() {
        return format!("HTTP {}", s.as_u16());
    }
    if e.is_timeout() {
        "Timeout".into()
    } else if e.is_connect() {
        "ConnectionError".into()
    } else if e.is_decode() {
        "JSONDecodeError".into()
    } else if e.is_body() {
        "ChunkedEncodingError".into()
    } else {
        "RequestException".into()
    }
}

/// Dorme até t0 + intervalo, relendo o intervalo a cada segundo (mudança na UI vale na hora).
/// Retorna false se pediram para encerrar.
pub async fn sleep_until(t0: f64, mut iv: impl FnMut() -> f64, stop: &mut watch::Receiver<bool>) -> bool {
    loop {
        if *stop.borrow() {
            return false;
        }
        let rem = t0 + iv().max(1.0) - now();
        if rem <= 0.0 {
            return true;
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs_f64(rem.min(1.0))) => {}
            _ = stop.changed() => return false,
        }
    }
}
