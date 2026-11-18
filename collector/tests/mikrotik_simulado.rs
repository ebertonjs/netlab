//! MikroTik simulado: a coleta real (Mt::poll) contra um servidor HTTP falso.
mod comum;
use std::time::Duration;

use comum::*;
use netnoc_collector::db::Rec;
use netnoc_collector::mikrotik::Mt;
use serde_json::json;

fn roteador(rx: &'static str) -> impl Fn(&str) -> Resp {
    move |path| match path {
        "/rest/system/resource" => json(
            200,
            json!({"cpu-load": "7", "uptime": "2d3h", "free-memory": "100", "total-memory": "400",
            "free-hdd-space": "1", "total-hdd-space": "2", "board-name": "hAP ax^2", "version": "7.16.1 (stable)"}),
        ),
        "/rest/system/health" => json(200, json!([{"name": "cpu-temperature", "value": "51"}])),
        "/rest/interface" => json(
            200,
            json!([
            {"name": "ether1", "running": "true", "disabled": "false", "rx-byte": rx, "tx-byte": "1000", "comment": "WAN <operadora>"},
            {"name": "ether2", "running": "false", "disabled": "true", "rx-byte": "0", "tx-byte": "0"}]),
        ),
        _ => raw(404, "{}"),
    }
}

#[tokio::test]
async fn coleta_completa_com_autenticacao() {
    let m = mock(roteador("1000000")).await;
    let mut mt = Mt::new(Duration::from_secs(3));
    let (recs, err) = mt.poll(&integ(m.port, "netnoc")).await;
    assert!(err.is_none(), "{err:?}");
    let res = recs.iter().find_map(|r| match r {
        Rec::MtResource { cpu_load, uptime_s, temperature, board_name, .. } => {
            Some((*cpu_load, *uptime_s, *temperature, board_name.clone()))
        }
        _ => None,
    });
    assert_eq!(res, Some((7.0, Some(2 * 86400 + 3 * 3600), Some(51.0), Some("hAP ax^2".into()))));
    let ifs: Vec<_> = recs.iter().filter(|r| matches!(r, Rec::MtIface { .. })).collect();
    assert_eq!(ifs.len(), 2);
    let comments = recs.iter().find_map(|r| match r {
        Rec::Meta { key, value, .. } if key == "mt_comments" => Some(value.clone()),
        _ => None,
    });
    assert!(comments.unwrap().contains("WAN operadora"), "comentário limpo de < >");
    let reqs = m.reqs.lock().unwrap().clone();
    assert!(reqs.iter().all(|r| r.auth.as_deref().is_some_and(|a| a.starts_with("Basic "))), "basic auth em todas");
    assert!(reqs.iter().all(|r| !r.path.contains("/rest/rest/")), "endereço sem /rest duplicado");
}

#[tokio::test]
async fn bps_calculado_entre_duas_coletas() {
    let m1 = mock(roteador("1000000")).await;
    let mut mt = Mt::new(Duration::from_secs(3));
    mt.poll(&integ(m1.port, "u")).await;
    tokio::time::sleep(Duration::from_millis(1100)).await;
    let m2 = mock(roteador("2000000")).await; // +1 MB em ~1,1 s
    let (recs, _) = mt.poll(&integ(m2.port, "u")).await;
    let bps = recs.iter().find_map(|r| match r {
        Rec::MtIface { name, rx_bps, .. } if name == "ether1" => Some(*rx_bps),
        _ => None,
    });
    let bps = bps.unwrap();
    assert!((6.0e6..8.5e6).contains(&bps), "≈ 8 Mbit / 1,1 s, veio {bps}");
}

#[tokio::test]
async fn erros_viram_mensagens_curtas() {
    type Handler = Box<dyn Fn(&str) -> Resp + Send + Sync>;
    let casos: Vec<(Handler, &str)> = vec![
        (Box::new(|_: &str| raw(401, "{\"error\":401}")), "HTTP 401"),
        (Box::new(|_: &str| raw(500, "boom")), "HTTP 500"),
        (Box::new(|_: &str| raw(200, "isso não é json")), "JSONDecodeError"),
        (Box::new(|_: &str| Resp { status: 200, body: "{}".into(), delay_ms: 3000 }), "Timeout"),
    ];
    for (h, esperado) in casos {
        let m = mock(move |p| h(p)).await;
        let mut mt = Mt::new(Duration::from_millis(800));
        let (recs, err) = mt.poll(&integ(m.port, "u")).await;
        assert_eq!(err.as_deref(), Some(esperado));
        assert!(recs.is_empty(), "nada gravado quando o system/resource falha");
    }
    let mut mt = Mt::new(Duration::from_secs(2));
    let (_, err) = mt.poll(&integ(porta_fechada().await, "u")).await;
    assert_eq!(err.as_deref(), Some("ConnectionError"));
}

#[tokio::test]
async fn senha_nunca_aparece_no_erro() {
    let m = mock(|_| raw(403, "{\"detail\":\"segredo\"}")).await;
    let mut mt = Mt::new(Duration::from_secs(2));
    let (_, err) = mt.poll(&integ(m.port, "u")).await;
    assert!(!err.unwrap().contains("segredo"));
}
