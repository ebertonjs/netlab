//! Configuração: arquivo TOML (opcional) + variáveis de ambiente (têm prioridade).
//!
//! Validação rigorosa: campo desconhecido no arquivo é erro (pega erro de digitação), valor fora da
//! faixa é erro com a faixa válida (nada é "corrigido" em silêncio), módulo desconhecido em
//! NETNOC_COLLECTOR_MODULES é erro, e todos os problemas são mostrados de uma vez.
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
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
    pub retry: RetryCfg,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Modules {
    pub ping: bool,
    pub mikrotik: bool,
    pub agh: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
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
    /// Por quanto tempo um nome resolvido (DNS) é reaproveitado
    pub dns_cache_secs: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct RetryCfg {
    /// Teto do backoff exponencial do MikroTik/AdGuard quando o equipamento não responde
    pub max_backoff_secs: u64,
    /// Teto do backoff da resolução de DNS de um destino que não resolve
    pub dns_max_backoff_secs: u64,
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
            retry: RetryCfg::default(),
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
        Self {
            tick_ms: 200,
            flush_ms: 1000,
            icmp_timeout_ms: 1000,
            tcp_timeout_ms: 2000,
            http_timeout_ms: 5000,
            max_inflight: 64,
            dns_cache_secs: 60,
        }
    }
}

impl Default for RetryCfg {
    fn default() -> Self {
        Self { max_backoff_secs: 600, dns_max_backoff_secs: 120 }
    }
}

const MODULES: &[&str] = &["ping", "mikrotik", "agh", "adguard"];

fn range<T: PartialOrd + std::fmt::Display + Copy>(errs: &mut Vec<String>, name: &str, v: T, lo: T, hi: T) {
    if v < lo || v > hi {
        errs.push(format!("{name} = {v} fora da faixa ({lo} a {hi})"));
    }
}

impl Config {
    /// Ordem: padrões < arquivo (-c / NETNOC_COLLECTOR_CONFIG / /etc/netnoc-collector.toml) < variáveis de ambiente.
    pub fn load(path: Option<&Path>) -> Result<Self> {
        let env = |k: &str| std::env::var(k).ok();
        let path = path.map(Path::to_path_buf).or_else(|| clean(env("NETNOC_COLLECTOR_CONFIG")).map(PathBuf::from)).or_else(|| {
            let p = PathBuf::from("/etc/netnoc-collector.toml");
            p.exists().then_some(p)
        });
        let text = match &path {
            Some(p) => Some(std::fs::read_to_string(p).with_context(|| format!("lendo {}", p.display()))?),
            None => None,
        };
        Self::from_parts(text.as_deref(), &env).with_context(|| match &path {
            Some(p) => format!("configuração inválida ({})", p.display()),
            None => "configuração inválida".into(),
        })
    }

    /// Monta e valida a configuração a partir do texto TOML (se houver) e de uma função que lê o ambiente.
    pub fn from_parts(toml_text: Option<&str>, env: &dyn Fn(&str) -> Option<String>) -> Result<Self> {
        let mut cfg: Config = match toml_text {
            Some(t) => toml::from_str(t).map_err(|e| anyhow::anyhow!("{}", e.message().trim()).context(where_in(t, &e)))?,
            None => Config::default(),
        };
        let env = |k: &str| clean(env(k));
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
        let mut errs = Vec::new();
        if let Some(v) = env("NETNOC_COLLECTOR_MODULES") {
            let on: Vec<String> = v.split(',').map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).collect();
            for m in &on {
                if !MODULES.contains(&m.as_str()) {
                    errs.push(format!("NETNOC_COLLECTOR_MODULES: módulo desconhecido '{m}' (use ping, mikrotik, agh)"));
                }
            }
            cfg.modules = Modules {
                ping: on.iter().any(|m| m == "ping"),
                mikrotik: on.iter().any(|m| m == "mikrotik"),
                agh: on.iter().any(|m| m == "agh" || m == "adguard"),
            };
        }
        errs.extend(cfg.problems());
        if !errs.is_empty() {
            bail!("{} problema(s):\n  - {}", errs.len(), errs.join("\n  - "));
        }
        Ok(cfg)
    }

    /// Lista tudo o que está fora do lugar (vazia = ok).
    pub fn problems(&self) -> Vec<String> {
        let mut e = Vec::new();
        if self.db.as_os_str().is_empty() {
            e.push("db: caminho vazio".into());
        }
        if tracing_subscriber::EnvFilter::try_new(&self.log_level).is_err() {
            e.push(format!("log_level = '{}' inválido (use trace, debug, info, warn ou error)", self.log_level));
        }
        range(&mut e, "settings_reload_secs", self.settings_reload_secs, 1, 300);
        let p = &self.ping;
        range(&mut e, "ping.tick_ms", p.tick_ms, 50, 5_000);
        range(&mut e, "ping.flush_ms", p.flush_ms, 200, 60_000);
        if p.flush_ms < p.tick_ms {
            e.push(format!("ping.flush_ms ({}) menor que ping.tick_ms ({})", p.flush_ms, p.tick_ms));
        }
        range(&mut e, "ping.icmp_timeout_ms", p.icmp_timeout_ms, 100, 10_000);
        range(&mut e, "ping.tcp_timeout_ms", p.tcp_timeout_ms, 100, 30_000);
        range(&mut e, "ping.http_timeout_ms", p.http_timeout_ms, 500, 60_000);
        range(&mut e, "ping.max_inflight", p.max_inflight, 1, 1024);
        range(&mut e, "ping.dns_cache_secs", p.dns_cache_secs, 0, 3_600);
        range(&mut e, "retry.max_backoff_secs", self.retry.max_backoff_secs, 30, 3_600);
        range(&mut e, "retry.dns_max_backoff_secs", self.retry.dns_max_backoff_secs, 5, 3_600);
        e
    }

    /// Avisos que não impedem de rodar (mostrados no log e no --check).
    pub fn warnings(&self) -> Vec<String> {
        let mut w = Vec::new();
        if !(self.modules.ping || self.modules.mikrotik || self.modules.agh) {
            w.push("nenhum módulo ativo ([modules] ou NETNOC_COLLECTOR_MODULES)".into());
        }
        if !self.db.exists() {
            w.push(format!("{} ainda não existe (o NetNOC em Python cria na primeira execução)", self.db.display()));
        }
        w
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

fn clean(v: Option<String>) -> Option<String> {
    v.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// "linha N" do erro do TOML, quando o parser informa a posição.
fn where_in(text: &str, e: &toml::de::Error) -> String {
    match e.span() {
        Some(s) => format!("linha {}", text[..s.start.min(text.len())].matches('\n').count() + 1),
        None => "arquivo TOML".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_env(_: &str) -> Option<String> {
        None
    }

    #[test]
    fn exemplo_do_repositorio_e_valido() {
        let c = Config::from_parts(Some(include_str!("../netnoc-collector.toml.example")), &no_env).expect("exemplo válido");
        assert!(c.modules.ping && c.modules.mikrotik && c.modules.agh);
        assert_eq!(c.ping.tick_ms, 200);
        assert_eq!(c.retry.max_backoff_secs, 600);
    }

    #[test]
    fn padrao_sem_arquivo() {
        let c = Config::from_parts(None, &no_env).unwrap();
        assert_eq!(c.db, PathBuf::from("netnoc.db"));
        assert_eq!(c.enabled_modules(), vec!["ping", "mikrotik", "agh"]);
    }

    #[test]
    fn campo_desconhecido_e_erro_com_linha() {
        let e = Config::from_parts(Some("db = \"x.db\"\n[ping]\ntick_sm = 100\n"), &no_env).unwrap_err();
        let msg = format!("{e:#}");
        assert!(msg.contains("tick_sm") && msg.contains("linha 3"), "{msg}");
    }

    #[test]
    fn tipo_errado_e_erro() {
        assert!(Config::from_parts(Some("[ping]\nmax_inflight = \"muitos\"\n"), &no_env).is_err());
    }

    #[test]
    fn fora_da_faixa_lista_tudo() {
        let t =
            "settings_reload_secs = 0\nlog_level = \"barulhento[\"\n[ping]\ntick_ms = 10\nflush_ms = 100\n[retry]\nmax_backoff_secs = 5\n";
        let msg = format!("{:#}", Config::from_parts(Some(t), &no_env).unwrap_err());
        for k in ["settings_reload_secs", "log_level", "ping.tick_ms", "ping.flush_ms", "retry.max_backoff_secs"] {
            assert!(msg.contains(k), "faltou {k} em: {msg}");
        }
        assert!(msg.contains("5 problema(s)") || msg.contains("6 problema(s)"), "{msg}");
    }

    #[test]
    fn ambiente_tem_prioridade() {
        let env = |k: &str| match k {
            "NETNOC_DB" => Some("/dados/netnoc.db".into()),
            "NETNOC_COLLECTOR_MODULES" => Some(" ping , adguard ".into()),
            "NETNOC_COLLECTOR_LOG" => Some("debug".into()),
            _ => None,
        };
        let c = Config::from_parts(Some("db = \"outro.db\"\n"), &env).unwrap();
        assert_eq!(c.db, PathBuf::from("/dados/netnoc.db"));
        assert_eq!(c.enabled_modules(), vec!["ping", "agh"]);
        assert_eq!(c.log_level, "debug");
        assert_eq!(c.hist_path(), PathBuf::from("/dados/netnoc-historico.db"));
    }

    #[test]
    fn modulo_desconhecido_no_ambiente_e_erro() {
        let env = |k: &str| (k == "NETNOC_COLLECTOR_MODULES").then(|| "ping,snmp".to_string());
        let msg = format!("{:#}", Config::from_parts(None, &env).unwrap_err());
        assert!(msg.contains("'snmp'"), "{msg}");
    }
}
