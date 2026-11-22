"""AdGuard Home: estatísticas, top de domínios e clientes.

Parte do antigo monitor.py (v4.4); o monitor.py continua reexportando tudo."""
import time


import requests

from netnoc.nucleo import db
from netnoc.nucleo import security

# --------------------------------------------------------------------------- AGH
_AGH_SECRET = ("password",)
_AGH_DEFAULTS = {"enabled": False, "host": "", "port": 3000, "use_https": False,
                 "username": "", "password": "", "sync_interval_seconds": 60}


def get_agh():
    return security.load_secret_cfg("agh", _AGH_DEFAULTS, _AGH_SECRET)


def set_agh(payload):
    cfg = dict(_AGH_DEFAULTS)
    cfg.update(payload)
    security.save_secret_cfg("agh", cfg, _AGH_SECRET)


def _agh_get(path, cfg=None):
    cfg = cfg or get_agh()
    if not cfg["host"]:
        raise ValueError("AdGuard Home não configurado")
    scheme = "https" if cfg["use_https"] else "http"
    auth = (cfg["username"], cfg["password"]) if cfg["username"] else None
    r = requests.get(f"{scheme}://{cfg['host']}:{cfg['port']}/control/{path}", auth=auth, timeout=6)
    r.raise_for_status()
    return r.json()


def test_agh_connection():
    return _agh_get("status", get_agh())


def _poll_agh_once(cfg):
    s = _agh_get("stats", cfg)
    db.execute(
        "INSERT INTO agh_stats(ts,num_dns_queries,num_blocked_filtering,num_replaced_safebrowsing,"
        "num_replaced_parental,avg_processing_time) VALUES(?,?,?,?,?,?)",
        (time.time(), s.get("num_dns_queries", 0), s.get("num_blocked_filtering", 0),
         s.get("num_replaced_safebrowsing", 0), s.get("num_replaced_parental", 0),
         s.get("avg_processing_time", 0)))


def agh_once():
    cfg = get_agh()
    if cfg["enabled"] and cfg["host"]:
        try:
            _poll_agh_once(cfg)
        except Exception as e:
            log_event(f"Falha ao coletar dados do AdGuard Home: {_safe_err(e)}", "Baixa")
            raise


def get_agh_status():
    cfg = get_agh()
    if not cfg["enabled"]:
        return None
    try:
        st = _agh_get("status", cfg)
    except Exception:
        return {"enabled": True, "host": cfg["host"], "online": False}
    return {"enabled": True, "host": cfg["host"], "online": True, "version": st.get("version"),
            "protection_enabled": st.get("protection_enabled"), "dns_addresses": st.get("dns_addresses")}


_agh_top_cache = [0.0, None]


def get_agh_top(n=5):
    """Top clientes / domínios consultados / domínios bloqueados do AdGuard (cache de 30 s)."""
    if time.time() - _agh_top_cache[0] < 30 and _agh_top_cache[1] is not None:
        return _agh_top_cache[1]
    s = _agh_get("stats")

    def norm(lst):
        out = []
        for it in (lst or [])[:n]:
            if isinstance(it, dict) and it:
                k, v = next(iter(it.items()))
                out.append({"name": str(k), "count": int(v) if isinstance(v, (int, float)) else 0})
        return out
    res = {"clients": norm(s.get("top_clients")), "queried": norm(s.get("top_queried_domains")),
           "blocked": norm(s.get("top_blocked_domains"))}
    _agh_top_cache[0], _agh_top_cache[1] = time.time(), res
    return res


def get_agh_stats_latest():
    rows = db.query("SELECT * FROM agh_stats ORDER BY ts DESC LIMIT 1")
    if not rows:
        return None
    row = rows[0]
    total = row["num_dns_queries"] or 0
    row["blocked_pct"] = round(100 * (row["num_blocked_filtering"] or 0) / total, 2) if total else 0
    return row


def get_agh_stats_history(seconds):
    return _downsample(db.query(
        "SELECT ts, num_dns_queries, num_blocked_filtering FROM agh_stats WHERE ts>=? ORDER BY ts ASC",
        (time.time() - seconds,)))


# dependências entre os módulos da coleta: no fim do arquivo porque há ciclos
# (ex.: incidentes avisa pelo Telegram, que consulta os destinos); só são usadas na hora da chamada
from netnoc.coleta.incidentes import log_event  # noqa: E402
from netnoc.coleta.mikrotik import _downsample, _safe_err  # noqa: E402
