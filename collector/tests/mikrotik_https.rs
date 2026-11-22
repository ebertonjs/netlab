//! MikroTik por HTTPS com certificado autoassinado (como o do RouterOS) e impressão digital fixada.
//! Os certificados em tests/fixtures/ são só de teste (gerados com openssl, sem uso real).
use std::sync::Arc;
use std::time::Duration;

use netnoc_collector::mikrotik::Mt;
use netnoc_collector::settings::Integration;
use netnoc_collector::tlspin;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;

const CERT: &[u8] = include_bytes!("fixtures/cert.der");
const KEY: &[u8] = include_bytes!("fixtures/key.der");
const OUTRO: &[u8] = include_bytes!("fixtures/outro.der");
const OUTRO_KEY: &[u8] = include_bytes!("fixtures/outro-key.der");

/// Servidor HTTPS que responde a qualquer GET com um JSON mínimo de /system/resource.
async fn servidor(cert: &'static [u8], key: &'static [u8]) -> u16 {
    let cfg = rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![CertificateDer::from(cert)], PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key)))
        .unwrap();
    let acc = TlsAcceptor::from(Arc::new(cfg));
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((s, _)) = l.accept().await else { return };
            let acc = acc.clone();
            tokio::spawn(async move {
                let Ok(mut t) = acc.accept(s).await else { return };
                let mut buf = [0u8; 4096];
                let _ = t.read(&mut buf).await;
                let path = String::from_utf8_lossy(&buf);
                let body = if path.contains("/rest/interface ") || path.contains("/rest/interface\r") {
                    "[]".to_string()
                } else if path.contains("system/resource") {
                    r#"{"cpu-load":"3","uptime":"1h","board-name":"hAP ax^2"}"#.to_string()
                } else {
                    "[]".to_string()
                };
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = t.write_all(resp.as_bytes()).await;
                let _ = t.shutdown().await;
            });
        }
    });
    port
}

fn integ(port: u16, pin: &str, verify: bool) -> Integration {
    Integration {
        enabled: true,
        host: "127.0.0.1".into(),
        port,
        use_https: true,
        verify_ssl: verify,
        cert_sha256: pin.into(),
        username: "netnoc".into(),
        password: "x".into(),
        interval_s: 60,
    }
}

#[tokio::test]
async fn certificado_fixado_aceito() {
    let port = servidor(CERT, KEY).await;
    let pin = tlspin::sha256_hex(CERT);
    let mut mt = Mt::new(Duration::from_secs(3));
    let (_, err) = mt.poll(&integ(port, &pin, true)).await;
    assert!(err.is_none(), "o certificado fixado deve passar mesmo com verify_ssl ligado: {err:?}");
}

#[tokio::test]
async fn certificado_trocado_recusado() {
    let port = servidor(OUTRO, OUTRO_KEY).await;
    let pin = tlspin::sha256_hex(CERT); // salvo o do roteador verdadeiro
    let mut mt = Mt::new(Duration::from_secs(3));
    let (recs, err) = mt.poll(&integ(port, &pin, false)).await;
    assert!(recs.is_empty());
    assert!(err.unwrap_or_default().contains("certificado mudou"), "impostor recusado com mensagem clara");
}

#[tokio::test]
async fn sem_pino_e_com_verificacao_recusa_autoassinado() {
    let port = servidor(CERT, KEY).await;
    let mut mt = Mt::new(Duration::from_secs(3));
    let (_, err) = mt.poll(&integ(port, "", true)).await;
    assert!(err.is_some(), "autoassinado sem pino não passa na verificação normal");
    let (_, err) = mt.poll(&integ(port, "", false)).await;
    assert!(err.is_none(), "verify_ssl desligado continua como antes: {err:?}");
}
