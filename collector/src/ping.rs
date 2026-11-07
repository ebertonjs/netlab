//! Ping de todos os destinos: ICMP nativo (surge-ping, sem subprocess), TCP (connect) e HTTP(S).
//! Cada destino tem seu intervalo (o do card ou o global). As sondas rodam em paralelo; os
//! resultados são juntados e gravados num commit a cada `flush_ms`.
//! Colunas iguais às do Python: ts = início da sonda, latency em ms (NULL se falhou),
//! jitter = |latência - última latência OK| (0 quando falha).
use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;
use std::time::Duration;

use rand::Rng;
use surge_ping::{Client, Config as PingConfig, PingIdentifier, PingSequence, ICMP};
use tokio::sync::{mpsc, watch, Semaphore};
use tokio::time::{interval, timeout, Instant, MissedTickBehavior};
use tracing::{debug, error, info, warn};

use crate::config::PingCfg;
use crate::db::{Db, Rec};
use crate::health::{now, Registry};
use crate::settings::{Shared, Target};

struct Probers {
    v4: Option<Client>,
    v6: Option<Client>,
    http: reqwest::Client,
    http_insecure: reqwest::Client,
    cfg: PingCfg,
}

fn icmp_client(kind: ICMP) -> Option<Client> {
    // DGRAM (sem privilégio, se net.ipv4.ping_group_range permitir) com fallback automático para RAW (CAP_NET_RAW)
    match Client::new(&PingConfig::builder().kind(kind).build()) {
        Ok(c) => Some(c),
        Err(e) if matches!(e.kind(), std::io::ErrorKind::PermissionDenied) => {
            error!(
                "sem permissão para abrir socket ICMP {kind:?}: {e} — rode com CAP_NET_RAW (AmbientCapabilities no systemd) \
                 ou libere net.ipv4.ping_group_range"
            );
            None
        }
        Err(e) => {
            // ex.: IPv6 desligado no kernel — só os destinos daquela família ficam sem ping
            warn!("ICMP {kind:?} indisponível neste sistema ({e}); destinos dessa família contarão como falha");
            None
        }
    }
}

/// Sequência ICMP global: uma resposta atrasada de uma sonda anterior nunca casa com a atual
static SEQ: AtomicU16 = AtomicU16::new(1);

impl Probers {
    fn new(cfg: PingCfg) -> anyhow::Result<Self> {
        let mk = |insecure: bool| {
            reqwest::Client::builder()
                .user_agent("NetNOC/3.0")
                .timeout(Duration::from_millis(cfg.http_timeout_ms))
                .connect_timeout(Duration::from_millis(cfg.http_timeout_ms))
                .danger_accept_invalid_certs(insecure)
                .redirect(reqwest::redirect::Policy::limited(10))
                .pool_max_idle_per_host(1)
                .build()
        };
        Ok(Self { v4: icmp_client(ICMP::V4), v6: icmp_client(ICMP::V6), http: mk(false)?, http_insecure: mk(true)?, cfg })
    }

    async fn resolve(&self, host: &str) -> Option<IpAddr> {
        let host = host.trim().trim_end_matches('.');
        if let Ok(ip) = host.trim_matches(|c| c == '[' || c == ']').parse::<IpAddr>() {
            return Some(ip);
        }
        let addrs = timeout(Duration::from_secs(2), tokio::net::lookup_host((host, 0))).await.ok()?.ok()?;
        let all: Vec<IpAddr> = addrs.map(|a| a.ip()).collect();
        all.iter().find(|i| i.is_ipv4()).or_else(|| all.first()).copied() // IPv4 primeiro, como o ping do sistema
    }

    async fn icmp(&self, host: &str) -> Option<f64> {
        let ip = self.resolve(host).await?;
        let client = if ip.is_ipv4() { self.v4.as_ref()? } else { self.v6.as_ref()? };
        let ident = PingIdentifier(rand::thread_rng().gen());
        let mut pinger = client.pinger(ip, ident).await;
        pinger.timeout(Duration::from_millis(self.cfg.icmp_timeout_ms));
        match pinger.ping(PingSequence(SEQ.fetch_add(1, Ordering::Relaxed)), &[0u8; 56]).await {
            Ok((_, rtt)) => Some(rtt.as_secs_f64() * 1000.0),
            Err(e) => {
                debug!("icmp {host}: {e}");
                None
            }
        }
    }

    async fn tcp(&self, host: &str, port: Option<u16>) -> Option<f64> {
        let port = port.filter(|p| *p > 0)?;
        let ip = self.resolve(host).await?;
        let t0 = Instant::now();
        match timeout(Duration::from_millis(self.cfg.tcp_timeout_ms), tokio::net::TcpStream::connect((ip, port))).await {
            Ok(Ok(_s)) => Some(t0.elapsed().as_secs_f64() * 1000.0),
            _ => None,
        }
    }

    /// Igual ao http_probe: tempo até os cabeçalhos; ok se == expect_status ou < 400
    async fn http(&self, t: &Target) -> Option<f64> {
        let url = t.host.trim();
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return None;
        }
        let client = if t.verify_ssl.unwrap_or(true) { &self.http } else { &self.http_insecure };
        let t0 = Instant::now();
        let r = client.get(url).send().await.ok()?;
        let ms = t0.elapsed().as_secs_f64() * 1000.0;
        let code = r.status().as_u16();
        drop(r);
        match t.expect_status {
            Some(e) if e > 0 => (code == e).then_some(ms),
            _ => (code < 400).then_some(ms),
        }
    }

    async fn probe(&self, t: &Target) -> Option<f64> {
        match t.kind.as_str() {
            "icmp" | "" => self.icmp(&t.host).await,
            "tcp" => self.tcp(&t.host, t.port).await,
            "http" => self.http(t).await,
            _ => None, // tipo desconhecido conta como falha (como checks.probe)
        }
    }
}

pub async fn run(db: Db, mut settings: watch::Receiver<Shared>, reg: Registry, cfg: PingCfg, mut stop: watch::Receiver<bool>) {
    let flush_every = Duration::from_millis(cfg.flush_ms);
    let probers = match Probers::new(cfg.clone()) {
        Ok(p) => Arc::new(p),
        Err(e) => {
            error!("ping: não foi possível iniciar o cliente HTTP: {e}");
            return;
        }
    };
    if probers.v4.is_none() {
        reg.ran("ping", 0.0, Some("sem permissão para ICMP (CAP_NET_RAW)".into()));
    }
    // dá tempo à tarefa que recebe as respostas ICMP de subir (a 1ª sonda falhava às vezes)
    tokio::time::sleep(Duration::from_millis(500)).await;
    let sem = Arc::new(Semaphore::new(cfg.max_inflight));
    let (res_tx, mut res_rx) = mpsc::unbounded_channel::<(String, f64, Option<f64>)>();
    let mut next_due: HashMap<String, f64> = HashMap::new();
    let mut inflight: HashSet<String> = HashSet::new();
    let mut last_ok: HashMap<String, f64> = HashMap::new();
    let mut buf: Vec<Rec> = Vec::new();
    let mut tick = interval(Duration::from_millis(cfg.tick_ms));
    tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut flush = interval(flush_every);
    flush.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut cur = settings.borrow_and_update().clone();
    info!("ping: {} destino(s), intervalo padrão {}s", cur.targets.len(), cur.ping_interval_s);

    loop {
        tokio::select! {
            _ = stop.changed() => break,
            Ok(()) = settings.changed() => {
                cur = settings.borrow_and_update().clone();
                let names: HashSet<&str> = cur.targets.iter().map(|t| t.name.as_str()).collect();
                next_due.retain(|k, _| names.contains(k.as_str()));
                last_ok.retain(|k, _| names.contains(k.as_str()));
            }
            _ = tick.tick() => {
                let t = now();
                for tg in cur.targets.iter() {
                    if tg.kind == "agent" || inflight.contains(&tg.name) {
                        continue;
                    }
                    if next_due.get(&tg.name).copied().unwrap_or(0.0) > t {
                        continue;
                    }
                    let iv = tg.interval.filter(|v| *v >= 1.0).unwrap_or(cur.ping_interval_s).max(1.0);
                    next_due.insert(tg.name.clone(), t + iv);
                    inflight.insert(tg.name.clone());
                    let (p, tx, sem, tg) = (probers.clone(), res_tx.clone(), sem.clone(), tg.clone());
                    tokio::spawn(async move {
                        let _permit = sem.acquire_owned().await;
                        let ts = now();
                        let lat = p.probe(&tg).await;
                        let _ = tx.send((tg.name, ts, lat));
                    });
                }
            }
            Some((name, ts, lat)) = res_rx.recv() => {
                inflight.remove(&name);
                if !cur.targets.iter().any(|t| t.name == name) {
                    continue; // destino removido enquanto a sonda estava em voo
                }
                let jitter = match (lat, last_ok.get(&name)) {
                    (Some(l), Some(p)) => (l - p).abs(),
                    _ => 0.0,
                };
                if let Some(l) = lat {
                    last_ok.insert(name.clone(), l);
                }
                buf.push(Rec::Ping { target: name, ts, latency: lat, success: lat.is_some(), jitter });
            }
            _ = flush.tick() => {
                if !buf.is_empty() {
                    let n = buf.len();
                    db.write(std::mem::take(&mut buf));
                    debug!("ping: {n} resultado(s) enviados ao banco");
                }
                let err = if probers.v4.is_none() { Some("sem permissão para ICMP (CAP_NET_RAW)".to_string()) } else { None };
                reg.ran("ping", cur.ping_interval_s, err);
            }
        }
    }
    if !buf.is_empty() {
        db.write(std::mem::take(&mut buf));
    }
    if !inflight.is_empty() {
        warn!("ping: {} sonda(s) em voo descartada(s) no encerramento", inflight.len());
    }
    info!("ping: encerrado");
}
