//! Agendador de ping com uma sonda simulada (respostas ICMP programadas) gravando num SQLite real.
mod comum;
use std::collections::{HashMap, VecDeque};
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use comum::*;
use netnoc_collector::config::{PingCfg, RetryCfg};
use netnoc_collector::health::Registry;
use netnoc_collector::ping::{self, BoxFuture, Probe};
use netnoc_collector::settings::{Settings, Target};
use netnoc_collector::{db, settings};
use tokio::sync::watch;

/// Sonda falsa: cada destino devolve a próxima resposta programada (None = sem resposta).
struct Roteiro {
    respostas: Mutex<HashMap<String, VecDeque<Option<f64>>>>,
    chamadas: Mutex<Vec<String>>,
}

impl Probe for Roteiro {
    fn probe<'a>(&'a self, t: &'a Target) -> BoxFuture<'a, Option<f64>> {
        Box::pin(async move {
            self.chamadas.lock().unwrap().push(t.name.clone());
            tokio::time::sleep(Duration::from_millis(5)).await;
            self.respostas.lock().unwrap().get_mut(&t.name).and_then(|q| q.pop_front()).unwrap_or(Some(10.0))
        })
    }
}

fn alvo(nome: &str, kind: &str, intervalo: Option<f64>) -> Target {
    serde_json::from_value(serde_json::json!({"name": nome, "host": "192.0.2.1", "type": kind, "interval": intervalo})).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn agenda_grava_latencia_falha_e_jitter() {
    let t = TmpDb::new("ping");
    let conn = db::open(t.db.clone(), t.hist.clone()).unwrap();
    assert!(db::missing_tables(&conn).unwrap().is_empty());
    let dbh = db::spawn(conn);
    let roteiro = Arc::new(Roteiro {
        respostas: Mutex::new(HashMap::from([
            ("Gateway".to_string(), VecDeque::from([Some(1.0), Some(3.0), None, Some(2.0)])),
            ("Google".to_string(), VecDeque::from([None, None, None])),
        ])),
        chamadas: Mutex::new(Vec::new()),
    });
    let cfg_settings = Settings {
        targets: vec![alvo("Gateway", "icmp", Some(1.0)), alvo("Google", "icmp", None), alvo("Filial", "agent", None)],
        ping_interval_s: 1.0,
        ..Default::default()
    };
    let (_set_tx, set_rx) = watch::channel(Arc::new(cfg_settings));
    let (stop_tx, stop_rx) = watch::channel(false);
    let cfg = PingCfg { tick_ms: 50, flush_ms: 200, ..Default::default() };
    let reg = Registry::default();
    let h = tokio::spawn(ping::run_with(roteiro.clone(), dbh.clone(), set_rx, reg.clone(), cfg, stop_rx));
    tokio::time::sleep(Duration::from_millis(3600)).await;
    stop_tx.send(true).unwrap();
    h.await.unwrap();
    dbh.stop().await;

    let c = t.conn();
    let rows: Vec<(String, Option<f64>, i64, f64)> = c
        .prepare("SELECT target, latency, success, jitter FROM h.pings ORDER BY target, ts")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    let gw: Vec<_> = rows.iter().filter(|r| r.0 == "Gateway").collect();
    let gg: Vec<_> = rows.iter().filter(|r| r.0 == "Google").collect();
    assert!((4..=5).contains(&gw.len()) || gw.len() == 3 && std::env::var("CI").is_ok(), "1 sonda por segundo em ~3,6 s: {gw:?}");
    assert_eq!(gw[0].1, Some(1.0));
    assert_eq!((gw[1].1, gw[1].3), (Some(3.0), 2.0), "jitter = |3 - 1|");
    assert_eq!((gw[2].1, gw[2].2, gw[2].3), (None, 0, 0.0), "falha: latência nula, success 0, jitter 0");
    if gw.len() > 3 {
        assert_eq!((gw[3].1, gw[3].3), (Some(2.0), 1.0), "jitter conta da última resposta OK (3 ms)");
    }
    assert!(gg.iter().take(3).all(|r| r.1.is_none() && r.2 == 0), "destino fora continua sendo testado no intervalo: {gg:?}");
    assert!(gg.len() >= 4, "sem backoff no ping: {gg:?}");
    assert!(!roteiro.chamadas.lock().unwrap().iter().any(|n| n == "Filial"), "tipo agent não é pingado");
    assert!(reg.snapshot().get("ping").is_some_and(|h| h.error.is_none() && h.runs > 0));
}

#[tokio::test]
async fn destino_removido_some_da_agenda() {
    let t = TmpDb::new("remove");
    let dbh = db::spawn(db::open(t.db.clone(), t.hist.clone()).unwrap());
    let roteiro = Arc::new(Roteiro { respostas: Mutex::new(HashMap::new()), chamadas: Mutex::new(Vec::new()) });
    let s1 = Settings { targets: vec![alvo("A", "icmp", None), alvo("B", "icmp", None)], ping_interval_s: 1.0, ..Default::default() };
    let (set_tx, set_rx) = watch::channel(Arc::new(s1));
    let (stop_tx, stop_rx) = watch::channel(false);
    let cfg = PingCfg { tick_ms: 50, flush_ms: 200, ..Default::default() };
    let h = tokio::spawn(ping::run_with(roteiro.clone(), dbh.clone(), set_rx, Registry::default(), cfg, stop_rx));
    tokio::time::sleep(Duration::from_millis(500)).await;
    set_tx.send(Arc::new(Settings { targets: vec![alvo("A", "icmp", None)], ping_interval_s: 1.0, ..Default::default() })).unwrap();
    roteiro.chamadas.lock().unwrap().clear();
    tokio::time::sleep(Duration::from_millis(2300)).await;
    stop_tx.send(true).unwrap();
    h.await.unwrap();
    dbh.stop().await;
    let ch = roteiro.chamadas.lock().unwrap().clone();
    assert!(ch.iter().any(|n| n == "A") && !ch.iter().any(|n| n == "B"), "{ch:?}");
}

/// ICMP de verdade em 127.0.0.1. Precisa de CAP_NET_RAW (ou ping_group_range): `cargo test -- --ignored`.
#[tokio::test]
#[ignore]
async fn icmp_real_no_loopback() {
    let p = ping::Probers::new(PingCfg::default(), &RetryCfg::default()).unwrap();
    if let Some(e) = p.health_error() {
        panic!("{e}");
    }
    let lat = p.probe(&alvo("lo", "icmp", None)).await;
    assert!(lat.is_some_and(|ms| ms < 50.0), "{lat:?}");
    let _: Option<IpAddr> = None;
    let _ = settings::clean_name("x", 1);
}
