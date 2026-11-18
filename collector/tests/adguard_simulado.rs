//! AdGuard Home simulado: agh::poll contra um servidor HTTP falso.
mod comum;
use std::time::Duration;

use comum::*;
use netnoc_collector::{agh, db::Rec};
use serde_json::json;

#[tokio::test]
async fn le_estatisticas() {
    let m = mock(|p| {
        assert_eq!(p, "/control/stats");
        json(
            200,
            json!({"num_dns_queries": 1500, "num_blocked_filtering": 120, "num_replaced_safebrowsing": 3,
                         "num_replaced_parental": 0, "avg_processing_time": 0.012}),
        )
    })
    .await;
    let r = agh::poll(&agh::client(Duration::from_secs(2)), &integ(m.port, "admin")).await.unwrap();
    match r {
        Rec::Agh { queries, blocked, safebrowsing, avg_ms, .. } => {
            assert_eq!((queries, blocked, safebrowsing), (1500, 120, 3));
            assert!((avg_ms - 0.012).abs() < 1e-9);
        }
        _ => panic!("registro errado"),
    }
    assert!(m.reqs.lock().unwrap()[0].auth.is_some(), "com usuário = basic auth");
}

#[tokio::test]
async fn sem_usuario_nao_manda_autenticacao() {
    let m = mock(|_| json(200, json!({"num_dns_queries": 1}))).await;
    agh::poll(&agh::client(Duration::from_secs(2)), &integ(m.port, "")).await.unwrap();
    assert!(m.reqs.lock().unwrap()[0].auth.is_none());
}

#[tokio::test]
async fn falhas() {
    let c = agh::client(Duration::from_millis(800));
    let m = mock(|_| raw(401, "{}")).await;
    assert_eq!(agh::poll(&c, &integ(m.port, "a")).await.unwrap_err(), "HTTP 401");
    let m = mock(|_| json(200, json!([1, 2, 3]))).await;
    assert_eq!(agh::poll(&c, &integ(m.port, "a")).await.unwrap_err(), "JSONDecodeError");
    assert_eq!(agh::poll(&c, &integ(porta_fechada().await, "a")).await.unwrap_err(), "ConnectionError");
}
