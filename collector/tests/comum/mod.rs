//! Utilidades dos testes de integração: servidor HTTP falso (MikroTik/AdGuard simulados) e um
//! banco SQLite temporário com o mesmo schema que o NetNOC em Python cria.
#![allow(dead_code)]
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use netnoc_collector::settings::Integration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// Resposta do servidor falso: status, corpo e atraso (para simular timeout).
pub struct Resp {
    pub status: u16,
    pub body: String,
    pub delay_ms: u64,
}

pub fn json(status: u16, body: serde_json::Value) -> Resp {
    Resp { status, body: body.to_string(), delay_ms: 0 }
}

pub fn raw(status: u16, body: &str) -> Resp {
    Resp { status, body: body.into(), delay_ms: 0 }
}

/// Pedido recebido: caminho e cabeçalho Authorization.
#[derive(Debug, Clone)]
pub struct Req {
    pub path: String,
    pub auth: Option<String>,
}

pub struct Mock {
    pub port: u16,
    pub reqs: Arc<Mutex<Vec<Req>>>,
}

/// Sobe um servidor HTTP/1.1 mínimo em 127.0.0.1:porta-livre; `handler(caminho)` decide a resposta.
pub async fn mock<F>(handler: F) -> Mock
where
    F: Fn(&str) -> Resp + Send + Sync + 'static,
{
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    let reqs = Arc::new(Mutex::new(Vec::new()));
    let (h, r) = (Arc::new(handler), reqs.clone());
    tokio::spawn(async move {
        loop {
            let Ok((mut s, _)) = l.accept().await else { return };
            let (h, r) = (h.clone(), r.clone());
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut tmp = [0u8; 2048];
                while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    match s.read(&mut tmp).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => buf.extend_from_slice(&tmp[..n]),
                    }
                }
                let head = String::from_utf8_lossy(&buf).to_string();
                let path = head.split_whitespace().nth(1).unwrap_or("/").to_string();
                let auth = head
                    .lines()
                    .find(|l| l.to_ascii_lowercase().starts_with("authorization:"))
                    .map(|l| l.split_once(':').map(|x| x.1).unwrap_or("").trim().to_string());
                r.lock().unwrap().push(Req { path: path.clone(), auth });
                let resp = h(&path);
                if resp.delay_ms > 0 {
                    tokio::time::sleep(Duration::from_millis(resp.delay_ms)).await;
                }
                let out = format!(
                    "HTTP/1.1 {} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    resp.status,
                    resp.body.len(),
                    resp.body
                );
                let _ = s.write_all(out.as_bytes()).await;
                let _ = s.shutdown().await;
            });
        }
    });
    Mock { port, reqs }
}

/// Integração apontando para o servidor falso (http, sem TLS).
pub fn integ(port: u16, user: &str) -> Integration {
    Integration {
        enabled: true,
        host: "127.0.0.1".into(),
        port,
        use_https: false,
        verify_ssl: true,
        username: user.into(),
        password: "segredo".into(),
        interval_s: 60,
    }
}

/// Porta onde nada escuta (conexão recusada).
pub async fn porta_fechada() -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let p = l.local_addr().unwrap().port();
    drop(l);
    p
}

/// Banco temporário: netnoc.db (settings) + netnoc-historico.db (tabelas que o coletor grava).
pub struct TmpDb {
    pub dir: PathBuf,
    pub db: PathBuf,
    pub hist: PathBuf,
}

impl TmpDb {
    pub fn new(nome: &str) -> Self {
        let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("netnoc-teste-{nome}-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (db, hist) = (dir.join("netnoc.db"), dir.join("netnoc-historico.db"));
        let c = rusqlite::Connection::open(&db).unwrap();
        c.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT);").unwrap();
        let h = rusqlite::Connection::open(&hist).unwrap();
        h.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE pings(id INTEGER PRIMARY KEY AUTOINCREMENT, target TEXT, ts REAL, latency REAL, success INTEGER, jitter REAL);
             CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL, message TEXT, severity TEXT);
             CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT, ts REAL);
             CREATE TABLE mikrotik_resource(ts REAL, cpu_load REAL, uptime_s INTEGER, free_memory INTEGER, total_memory INTEGER,
                 free_hdd INTEGER, total_hdd INTEGER, temperature REAL, board_name TEXT, version TEXT);
             CREATE TABLE mikrotik_iface(ts REAL, name TEXT, running INTEGER, disabled INTEGER, rx_bytes INTEGER, tx_bytes INTEGER,
                 rx_bps REAL, tx_bps REAL);
             CREATE TABLE agh_stats(ts REAL, num_dns_queries INTEGER, num_blocked_filtering INTEGER, num_replaced_safebrowsing INTEGER,
                 num_replaced_parental INTEGER, avg_processing_time REAL);",
        )
        .unwrap();
        Self { dir, db, hist }
    }

    pub fn conn(&self) -> rusqlite::Connection {
        let c = rusqlite::Connection::open(&self.db).unwrap();
        c.execute("ATTACH DATABASE ?1 AS h", [self.hist.to_string_lossy()]).unwrap();
        c
    }
}

impl Drop for TmpDb {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
