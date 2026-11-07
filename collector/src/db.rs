//! Acesso ao SQLite numa thread dedicada (rusqlite é síncrono).
//! O schema é do Python (db.py): aqui só se lê `settings` e se grava no histórico anexado como `h`.
//! Cada lote enviado vira UMA transação; lotes que falham (ex.: banco ocupado além do busy_timeout)
//! ficam guardados e são regravados junto com o próximo.
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use tokio::sync::{mpsc, oneshot};
use tracing::{debug, error, info, warn};

/// Tabelas do histórico que o coletor escreve (criadas pelo NetNOC em Python).
pub const NEEDED: &[&str] = &["pings", "mikrotik_resource", "mikrotik_iface", "agh_stats", "events", "meta"];
const MAX_PENDING: usize = 50_000;

#[derive(Debug, Clone)]
pub enum Rec {
    Ping {
        target: String,
        ts: f64,
        latency: Option<f64>,
        success: bool,
        jitter: f64,
    },
    MtResource {
        ts: f64,
        cpu_load: f64,
        uptime_s: Option<i64>,
        free_memory: i64,
        total_memory: i64,
        free_hdd: i64,
        total_hdd: i64,
        temperature: Option<f64>,
        board_name: Option<String>,
        version: Option<String>,
    },
    MtIface {
        ts: f64,
        name: String,
        running: bool,
        disabled: bool,
        rx_bytes: i64,
        tx_bytes: i64,
        rx_bps: f64,
        tx_bps: f64,
    },
    Agh {
        ts: f64,
        queries: i64,
        blocked: i64,
        safebrowsing: i64,
        parental: i64,
        avg_ms: f64,
    },
    Event {
        ts: f64,
        message: String,
        severity: &'static str,
    },
    Meta {
        key: String,
        value: String,
        ts: f64,
    },
}

/// Valores crus de `settings` (JSON em texto), interpretados em settings.rs
#[derive(Debug, Default, Clone)]
pub struct RawSettings {
    pub targets: Option<String>,
    pub intervals: Option<String>,
    pub mikrotik: Option<String>,
    pub agh: Option<String>,
}

pub enum Cmd {
    Write(Vec<Rec>),
    Settings(oneshot::Sender<Result<RawSettings>>),
    Stop(oneshot::Sender<()>),
}

#[derive(Clone)]
pub struct Db {
    tx: mpsc::UnboundedSender<Cmd>,
}

impl Db {
    pub fn write(&self, recs: Vec<Rec>) {
        if !recs.is_empty() && self.tx.send(Cmd::Write(recs)).is_err() {
            warn!("banco já fechado: lote descartado");
        }
    }

    pub async fn settings(&self) -> Result<RawSettings> {
        let (tx, rx) = oneshot::channel();
        self.tx.send(Cmd::Settings(tx)).map_err(|_| anyhow::anyhow!("thread do banco parada"))?;
        rx.await.map_err(|_| anyhow::anyhow!("thread do banco parada"))?
    }

    /// Grava o que estiver pendente e fecha a conexão (chamado no SIGTERM).
    pub async fn stop(&self) {
        let (tx, rx) = oneshot::channel();
        if self.tx.send(Cmd::Stop(tx)).is_ok() {
            let _ = tokio::time::timeout(Duration::from_secs(20), rx).await;
        }
    }
}

pub fn open(db: PathBuf, hist: PathBuf) -> Result<Connection> {
    if !db.exists() {
        bail!("banco não encontrado: {} (inicie o NetNOC uma vez para criá-lo)", db.display());
    }
    let c = Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .with_context(|| format!("abrindo {}", db.display()))?;
    c.busy_timeout(Duration::from_secs(15))?;
    c.execute("ATTACH DATABASE ?1 AS h", params![hist.to_string_lossy()]).with_context(|| format!("anexando {}", hist.display()))?;
    // mesmo modo do Python; journal_mode é persistente no arquivo, aqui só confirma
    for sch in ["main", "h"] {
        let mode: String = c.query_row(&format!("PRAGMA {sch}.journal_mode=WAL"), [], |r| r.get(0))?;
        if !mode.eq_ignore_ascii_case("wal") {
            warn!("{sch}: journal_mode={mode} (esperado WAL)");
        }
        c.execute_batch(&format!("PRAGMA {sch}.synchronous=NORMAL"))?;
    }
    Ok(c)
}

pub fn missing_tables(c: &Connection) -> Result<Vec<&'static str>> {
    let mut out = Vec::new();
    for t in NEEDED {
        let found: Option<i64> =
            c.query_row("SELECT 1 FROM h.sqlite_master WHERE type='table' AND name=?1", params![t], |r| r.get(0)).optional()?;
        if found.is_none() {
            out.push(*t);
        }
    }
    Ok(out)
}

fn read_settings(c: &Connection) -> Result<RawSettings> {
    let mut st = c.prepare_cached("SELECT key, value FROM main.settings WHERE key IN ('targets','intervals','mikrotik','agh')")?;
    let mut out = RawSettings::default();
    let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)))?;
    for row in rows {
        let (k, v) = row?;
        match k.as_str() {
            "targets" => out.targets = v,
            "intervals" => out.intervals = v,
            "mikrotik" => out.mikrotik = v,
            "agh" => out.agh = v,
            _ => {}
        }
    }
    Ok(out)
}

fn write_batch(c: &mut Connection, recs: &[Rec]) -> Result<()> {
    let tx = c.transaction()?;
    {
        for r in recs {
            match r {
                Rec::Ping { target, ts, latency, success, jitter } => {
                    tx.prepare_cached("INSERT INTO h.pings(target,ts,latency,success,jitter) VALUES(?1,?2,?3,?4,?5)")?.execute(params![
                        target,
                        ts,
                        latency,
                        *success as i64,
                        jitter
                    ])?;
                }
                Rec::MtResource {
                    ts,
                    cpu_load,
                    uptime_s,
                    free_memory,
                    total_memory,
                    free_hdd,
                    total_hdd,
                    temperature,
                    board_name,
                    version,
                } => {
                    tx.prepare_cached(
                        "INSERT INTO h.mikrotik_resource(ts,cpu_load,uptime_s,free_memory,total_memory,free_hdd,total_hdd,temperature,board_name,version) \
                         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                    )?
                    .execute(params![ts, cpu_load, uptime_s, free_memory, total_memory, free_hdd, total_hdd, temperature, board_name, version])?;
                }
                Rec::MtIface { ts, name, running, disabled, rx_bytes, tx_bytes, rx_bps, tx_bps } => {
                    tx.prepare_cached(
                        "INSERT INTO h.mikrotik_iface(ts,name,running,disabled,rx_bytes,tx_bytes,rx_bps,tx_bps) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
                    )?
                    .execute(params![ts, name, *running as i64, *disabled as i64, rx_bytes, tx_bytes, rx_bps, tx_bps])?;
                }
                Rec::Agh { ts, queries, blocked, safebrowsing, parental, avg_ms } => {
                    tx.prepare_cached(
                        "INSERT INTO h.agh_stats(ts,num_dns_queries,num_blocked_filtering,num_replaced_safebrowsing,num_replaced_parental,avg_processing_time) \
                         VALUES(?1,?2,?3,?4,?5,?6)",
                    )?
                    .execute(params![ts, queries, blocked, safebrowsing, parental, avg_ms])?;
                }
                Rec::Event { ts, message, severity } => {
                    tx.prepare_cached("INSERT INTO h.events(ts,message,severity) VALUES(?1,?2,?3)")?
                        .execute(params![ts, message, severity])?;
                }
                Rec::Meta { key, value, ts } => {
                    tx.prepare_cached(
                        "INSERT INTO h.meta(key,value,ts) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value, ts=excluded.ts",
                    )?
                    .execute(params![key, value, ts])?;
                }
            }
        }
    }
    tx.commit()?;
    Ok(())
}

/// Sobe a thread do banco. As escritas que chegarem juntas viram uma única transação.
pub fn spawn(mut conn: Connection) -> Db {
    let (tx, mut rx) = mpsc::unbounded_channel::<Cmd>();
    std::thread::Builder::new()
        .name("sqlite".into())
        .spawn(move || {
            let mut pending: Vec<Rec> = Vec::new();
            'main: while let Some(first) = rx.blocking_recv() {
                let mut cmds = vec![first];
                while let Ok(c) = rx.try_recv() {
                    cmds.push(c);
                }
                let mut others = Vec::new();
                for c in cmds {
                    match c {
                        Cmd::Write(mut r) => pending.append(&mut r),
                        other => others.push(other),
                    }
                }
                flush(&mut conn, &mut pending);
                for c in others {
                    match c {
                        Cmd::Settings(reply) => {
                            let _ = reply.send(read_settings(&conn));
                        }
                        Cmd::Stop(done) => {
                            // escritas que chegaram depois do Stop também entram
                            while let Ok(Cmd::Write(mut r)) = rx.try_recv() {
                                pending.append(&mut r);
                            }
                            flush(&mut conn, &mut pending);
                            if !pending.is_empty() {
                                error!("{} registro(s) não puderam ser gravados no encerramento", pending.len());
                            }
                            // checkpoint passivo: não bloqueia o Python; o WAL já é consistente de qualquer forma
                            let _ = conn.query_row("PRAGMA h.wal_checkpoint(PASSIVE)", [], |_| Ok(()));
                            info!("banco fechado");
                            let _ = done.send(());
                            break 'main;
                        }
                        Cmd::Write(_) => {}
                    }
                }
            }
            drop(conn);
        })
        .expect("thread do banco");
    Db { tx }
}

fn flush(conn: &mut Connection, pending: &mut Vec<Rec>) {
    if pending.is_empty() {
        return;
    }
    match write_batch(conn, pending) {
        Ok(()) => {
            debug!("gravado: {} registro(s)", pending.len());
            pending.clear();
        }
        Err(e) => {
            warn!("falha ao gravar {} registro(s), tento de novo no próximo lote: {e:#}", pending.len());
            if pending.len() > MAX_PENDING {
                let drop_n = pending.len() - MAX_PENDING;
                pending.drain(..drop_n);
                error!("fila de gravação cheia: {drop_n} registro(s) antigo(s) descartado(s)");
            }
        }
    }
}
