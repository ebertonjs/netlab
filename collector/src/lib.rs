//! netnoc-collector como biblioteca: os módulos ficam públicos para o binário (main.rs) e para os
//! testes de integração em tests/ (MikroTik/AdGuard simulados, agendador de ping com sonda falsa).
pub mod agh;
pub mod backoff;
pub mod config;
pub mod db;
pub mod health;
pub mod mikrotik;
pub mod ping;
pub mod settings;
pub mod tlspin;
