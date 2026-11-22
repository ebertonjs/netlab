//! Lê o que a interface do NetNOC grava em `settings` (mesmos padrões do monitor.py)
//! e decifra as senhas (Fernet, prefixo "enc:v1:", mesma chave netnoc.key).
use std::path::Path;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;
use tracing::warn;

use crate::db::RawSettings;

const ENC_PREFIX: &str = "enc:v1:";

#[derive(Debug, Clone, Deserialize)]
pub struct Target {
    pub name: String,
    pub host: String,
    #[serde(rename = "type", default = "icmp")]
    pub kind: String,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub interval: Option<f64>,
    #[serde(default)]
    pub expect_status: Option<u16>,
    #[serde(default)]
    pub verify_ssl: Option<bool>,
}

fn icmp() -> String {
    "icmp".into()
}

#[derive(Debug, Clone, Default)]
pub struct Integration {
    pub enabled: bool,
    pub host: String,
    pub port: u16,
    pub use_https: bool,
    pub verify_ssl: bool,
    /// v4.1: impressão digital SHA-256 fixada (vazio = usa verify_ssl)
    pub cert_sha256: String,
    pub username: String,
    pub password: String,
    pub interval_s: u64,
}

impl Integration {
    pub fn ready(&self, need_user: bool) -> bool {
        self.enabled && !self.host.is_empty() && (!need_user || !self.username.is_empty())
    }
    pub fn base(&self) -> String {
        let scheme = if self.use_https { "https" } else { "http" };
        let host = if self.host.contains(':') && !self.host.starts_with('[') { format!("[{}]", self.host) } else { self.host.clone() };
        format!("{scheme}://{host}:{}", self.port)
    }
}

#[derive(Debug, Clone, Default)]
pub struct Settings {
    pub targets: Vec<Target>,
    pub ping_interval_s: f64,
    pub mikrotik: Integration,
    pub agh: Integration,
}

pub type Shared = Arc<Settings>;

pub struct Secrets {
    fernet: Option<fernet::Fernet>,
    warned: std::sync::atomic::AtomicBool,
}

impl Secrets {
    pub fn load(key_file: &Path) -> Self {
        let key = std::env::var("NETNOC_SECRET_KEY")
            .ok()
            .filter(|k| !k.trim().is_empty())
            .or_else(|| std::fs::read_to_string(key_file).ok())
            .map(|k| k.trim().to_string());
        let fernet = key.as_deref().and_then(fernet::Fernet::new);
        if key.is_some() && fernet.is_none() {
            warn!("chave em {} inválida: senhas cifradas não poderão ser lidas", key_file.display());
        }
        Self { fernet, warned: false.into() }
    }

    pub fn has_key(&self) -> bool {
        self.fernet.is_some()
    }

    /// Igual ao security.decrypt do Python: texto sem prefixo passa direto; falha vira "".
    pub fn decrypt(&self, v: &str) -> String {
        let Some(tok) = v.strip_prefix(ENC_PREFIX) else { return v.to_string() };
        match &self.fernet {
            Some(f) => f.decrypt(tok).ok().and_then(|b| String::from_utf8(b).ok()).unwrap_or_default(),
            None => {
                if !self.warned.swap(true, std::sync::atomic::Ordering::Relaxed) {
                    warn!("senha cifrada no banco, mas a chave (netnoc.key / NETNOC_SECRET_KEY) não foi encontrada ou não pode ser lida");
                }
                String::new()
            }
        }
    }
}

fn parse_obj(s: &Option<String>) -> serde_json::Map<String, Value> {
    s.as_deref().and_then(|t| serde_json::from_str::<Value>(t).ok()).and_then(|v| v.as_object().cloned()).unwrap_or_default()
}

pub fn num(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        Value::Bool(b) => Some(*b as i64 as f64),
        _ => None,
    }
}

fn boolean(v: Option<&Value>, def: bool) -> bool {
    match v {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => matches!(s.as_str(), "true" | "1" | "yes" | "on"),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0) != 0.0,
        _ => def,
    }
}

fn text(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.trim().to_string(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

/// `_setting_interval` do Python: sync_interval_seconds (padrão 60), mínimo 15 s
fn integration(raw: &Option<String>, def_port: u16, def_https: bool, def_verify: bool, sec: &Secrets) -> Integration {
    let o = parse_obj(raw);
    Integration {
        enabled: boolean(o.get("enabled"), false),
        host: text(o.get("host")),
        port: num(o.get("port")).map(|p| p as u16).filter(|p| *p > 0).unwrap_or(def_port),
        use_https: boolean(o.get("use_https"), def_https),
        verify_ssl: boolean(o.get("verify_ssl"), def_verify),
        cert_sha256: text(o.get("cert_sha256")),
        username: text(o.get("username")),
        password: sec.decrypt(&text(o.get("password"))),
        interval_s: num(o.get("sync_interval_seconds")).map(|v| v as u64).unwrap_or(60).max(15),
    }
}

pub fn parse(raw: &RawSettings, sec: &Secrets) -> Settings {
    let targets: Vec<Target> = raw
        .targets
        .as_deref()
        .and_then(|t| serde_json::from_str::<Vec<Value>>(t).ok())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| serde_json::from_value::<Target>(v).map_err(|e| warn!("alvo ignorado (formato inesperado): {e}")).ok())
        .filter(|t| !t.name.is_empty() && !t.host.is_empty())
        .collect();
    let iv = parse_obj(&raw.intervals);
    Settings {
        targets,
        ping_interval_s: num(iv.get("ping_interval_seconds")).unwrap_or(5.0).clamp(1.0, 86400.0),
        // padrões iguais a _MIKROTIK_DEFAULTS / _AGH_DEFAULTS
        mikrotik: integration(&raw.mikrotik, 443, true, false, sec),
        agh: integration(&raw.agh, 3000, false, true, sec),
    }
}

/// security.clean_name: remove < > " ' & ` \ e caracteres de controle, corta no tamanho
pub fn clean_name(s: &str, max: usize) -> String {
    s.chars()
        .filter(|c| !matches!(c, '<' | '>' | '"' | '\'' | '&' | '`' | '\\') && !c.is_control())
        .collect::<String>()
        .trim()
        .chars()
        .take(max)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decifra_igual_ao_python() {
        // gerado com cryptography.fernet (Python) usando a mesma chave
        let key = "kFk1oS7oW0x0B3ExqfKC6eYQnd6M6l6LRCtl1Ek6bWM=";
        let f = fernet::Fernet::new(key).unwrap();
        let tok = f.encrypt(b"segredo");
        let s = Secrets { fernet: fernet::Fernet::new(key), warned: false.into() };
        assert_eq!(s.decrypt(&format!("{ENC_PREFIX}{tok}")), "segredo");
        assert_eq!(s.decrypt("texto-puro"), "texto-puro");
        assert_eq!(s.decrypt("enc:v1:lixo"), "");
    }

    #[test]
    fn limpa_nome() {
        assert_eq!(clean_name("  WAN <Operadora>\n", 40), "WAN Operadora");
        assert_eq!(clean_name("abcdef", 3), "abc");
    }

    #[test]
    fn le_settings() {
        let raw = RawSettings {
            targets: Some(r#"[{"name":"GW","host":"192.168.1.1"},{"name":"Site","host":"https://x","type":"http","expect_status":200,"interval":30},{"bad":1}]"#.into()),
            intervals: Some(r#"{"ping_interval_seconds": 2}"#.into()),
            mikrotik: Some(r#"{"enabled":true,"host":"10.0.0.1","port":"8443","username":"api","password":"x","sync_interval_seconds":5}"#.into()),
            agh: None,
        };
        let s = parse(&raw, &Secrets { fernet: None, warned: false.into() });
        assert_eq!(s.targets.len(), 2);
        assert_eq!(s.targets[1].kind, "http");
        assert_eq!(s.ping_interval_s, 2.0);
        assert_eq!(s.mikrotik.port, 8443);
        assert_eq!(s.mikrotik.interval_s, 15);
        assert!(s.mikrotik.ready(true));
        assert!(!s.agh.ready(false));
        assert_eq!(s.agh.port, 3000);
    }
}
