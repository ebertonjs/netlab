"""Configurações gerais: nome do painel, intervalos de coleta, migração de segredos antigos.

Parte do antigo monitor.py (v4.4); o monitor.py continua reexportando tudo."""
import json



from netnoc.nucleo import db
from netnoc.nucleo import security
from netnoc.coleta.base import CFG

# ------------------------------------------------------------------ settings
_intervals_cache = None

def init_settings():
    if db.get_setting("targets") is None:
        db.set_setting("targets", json.dumps(CFG["targets"]))
    if db.get_setting("dns_servers") is None:
        db.set_setting("dns_servers", json.dumps(CFG["dns_servers"]))
    if db.get_setting("intervals") is None:
        db.set_setting("intervals", json.dumps({
            "ping_interval_seconds": CFG["ping_interval_seconds"],
            "dns_check_interval_seconds": CFG["dns_check_interval_seconds"],
            "public_ip_interval_seconds": CFG["public_ip_interval_seconds"],
            "system_interval_seconds": CFG["system_interval_seconds"],
        }))
    if db.get_setting("telegram") is None:
        db.set_setting("telegram", json.dumps({
            "enabled": False, "bot_token": "", "chat_id": "", "min_severity": "Alta"}))
    if db.get_setting("app_name") is None:
        db.set_setting("app_name", CFG.get("app_name", "NetNOC"))
    migrate_secrets()


def migrate_secrets():
    """Recifra credenciais antigas que estavam em texto puro."""
    for key, fields in (("telegram", ("bot_token",)), ("mikrotik", ("password",)), ("agh", ("password",))):
        raw = db.get_setting(key)
        if not raw:
            continue
        try:
            cfg = json.loads(raw)
        except Exception:
            continue
        if any(cfg.get(f) and not str(cfg[f]).startswith(security.ENC_PREFIX) for f in fields):
            for f in fields:
                cfg[f] = security.encrypt(cfg.get(f) or "")
            db.set_setting(key, json.dumps(cfg))


def get_app_name():
    return db.get_setting("app_name", "NetNOC")


def set_app_name(name):
    name = (name or "").strip()
    if not name:
        raise ValueError("Nome não pode ser vazio")
    if len(name) > 40:
        raise ValueError("Nome muito longo (máx. 40 caracteres)")
    if not security.valid_name(name, 40):
        raise ValueError("Nome contém caracteres inválidos")
    db.set_setting("app_name", name)


_INTERVAL_DEFAULTS = {
    "ping_interval_seconds": 5, "dns_check_interval_seconds": 30,
    "public_ip_interval_seconds": 300, "system_interval_seconds": 5}


def get_intervals():
    global _intervals_cache
    if _intervals_cache is None:
        d = dict(_INTERVAL_DEFAULTS)
        try:
            d.update(json.loads(db.get_setting("intervals", "{}") or "{}"))
        except Exception:
            pass
        _intervals_cache = d
    return dict(_intervals_cache)


def invalidate_intervals():
    global _intervals_cache
    _intervals_cache = None


def set_intervals(data):
    current = get_intervals()
    for k, v in data.items():
        if v is None or k not in _INTERVAL_DEFAULTS:
            continue
        v = int(v)
        if not 1 <= v <= 86400:
            raise ValueError(f"{k}: valor deve estar entre 1 e 86400")
        current[k] = v
    db.set_setting("intervals", json.dumps(current))
    invalidate_intervals()

