//! Configuração: arquivo TOML (opcional) + variáveis de ambiente (têm prioridade).
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct Config {
    /// Caminho do netnoc.db (configuração). O histórico fica ao lado, como no Python.
    pub db: PathBuf,
    /// netnoc-historico.db (vazio = ao lado do netnoc.db)
    pub hist_db: Option<PathBuf>,
    /// Chave Fernet que cifra as senhas no banco (vazio = netnoc.key ao lado do netnoc.db)
    pub key_file: Option<PathBuf>,
    /// trace | debug | info | warn | error (ou um filtro do tracing, ex.: "info,netnoc_collector=debug")
    pub log_level: String,
    /// De quanto em quanto tempo relê alvos, intervalos e integrações do banco
    pub settings_reload_secs: u64,
    pub modules: Modules,
    pub ping: PingCfg,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct Modules {
    pub ping: bool,
    pub mikrotik: bool,
    pub agh: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct PingCfg {
    /// Resolução do agendador (quanto antes de vencer um alvo ele é disparado)
    pub tick_ms: u64,
    /// Junta os resultados e grava num único commit a cada flush_ms (poupa o cartão SD)
    pub flush_ms: u64,
    pub icmp_timeout_ms: u64,
    pub tcp_timeout_ms: u64,
    pub http_timeout_ms: u64,
    /// Máximo de sondas em voo ao mesmo tempo
    pub max_inflight: usize,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            db: PathBuf::from("netnoc.db"),
            hist_db: None,
            key_file: None,
            log_level: "info".into(),
            settings_reload_secs: 5,
            modules: Modules::default(),
            ping: PingCfg::default(),
        }
    }
}

impl Default for Modules {
    fn default() -> Self {
        Self { ping: true, mikrotik: true, agh: true }
    }
}

impl Default for PingCfg {
    fn default() -> Self {
        Self { tick_ms: 200, flush_ms: 1000, icmp_timeout_ms: 1000, tcp_timeout_ms: 2000, http_timeout_ms: 5000, max_inflight: 64 }
    }
}

fn env(k: &str) -> Option<String> {
    std::env::var(k).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

impl Config {
    /// Ordem: padrões < arquivo (-c / NETNOC_COLLECTOR_CONFIG / /etc/netnoc-collector.toml) < variáveis de ambiente.
    pub fn load(path: Option<&Path>) -> Result<Self> {
        let path = path.map(Path::to_path_buf).or_else(|| env("NETNOC_COLLECTOR_CONFIG").map(PathBuf::from)).or_else(|| {
            let p = PathBuf::from("/etc/netnoc-collector.toml");
            p.exists().then_some(p)
        });
        let mut cfg: Config = match &path {
            Some(p) => {
                let txt = std::fs::read_to_string(p).with_context(|| format!("lendo {}", p.display()))?;
                toml::from_str(&txt).with_context(|| format!("arquivo inválido: {}", p.display()))?
            }
            None => Config::default(),
        };
        if let Some(v) = env("NETNOC_DB") {
            cfg.db = v.into();
        }
        if let Some(v) = env("NETNOC_HIST_DB") {
            cfg.hist_db = Some(v.into());
        }
        if let Some(v) = env("NETNOC_KEY_FILE") {
            cfg.key_file = Some(v.into());
        }
        if let Some(v) = env("NETNOC_COLLECTOR_LOG") {
            cfg.log_level = v;
        }
        if let Some(v) = env("NETNOC_COLLECTOR_MODULES") {
            let on: Vec<String> = v.split(',').map(|s| s.trim().to_lowercase()).collect();
            cfg.modules = Modules {
                ping: on.iter().any(|m| m == "ping"),
                mikrotik: on.iter().any(|m| m == "mikrotik"),
                agh: on.iter().any(|m| m == "agh" || m == "adguard"),
            };
        }
        cfg.ping.tick_ms = cfg.ping.tick_ms.clamp(50, 5000);
        cfg.ping.flush_ms = cfg.ping.flush_ms.clamp(200, 60_000);
        cfg.ping.max_inflight = cfg.ping.max_inflight.clamp(1, 1024);
        cfg.settings_reload_secs = cfg.settings_reload_secs.clamp(1, 300);
        Ok(cfg)
    }

    fn dir(&self) -> PathBuf {
        std::fs::canonicalize(&self.db)
            .ok()
            .and_then(|p| p.parent().map(Path::to_path_buf))
            .or_else(|| self.db.parent().map(Path::to_path_buf))
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| PathBuf::from("."))
    }

    /// Mesma regra do db.py: NETNOC_HIST_DB ou netnoc-historico.db ao lado do netnoc.db
    pub fn hist_path(&self) -> PathBuf {
        self.hist_db.clone().unwrap_or_else(|| self.dir().join("netnoc-historico.db"))
    }

    pub fn key_path(&self) -> PathBuf {
        self.key_file.clone().unwrap_or_else(|| self.dir().join("netnoc.key"))
    }

    pub fn enabled_modules(&self) -> Vec<&'static str> {
        let mut v = Vec::new();
        if self.modules.ping {
            v.push("ping");
        }
        if self.modules.mikrotik {
            v.push("mikrotik");
        }
        if self.modules.agh {
            v.push("agh");
        }
        v
    }
}
