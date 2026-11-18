"""Coisas compartilhadas pelas rotas: versão, configuração, auditoria e utilidades de período/permissão."""
import time

from fastapi import HTTPException, Request

from netnoc.coleta import monitor
from netnoc.nucleo import db


CFG = monitor.CFG
APP_VERSION = "3.13"
STARTED_AT = time.time()

RANGE_SECONDS = {"5m": 300, "1h": 3600, "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400}


def actor(request: Request):
    st = request.scope.get("state", {})
    return st.get("user", "?"), st.get("ip", "")


def audit(request, action, detail=""):
    u, ip = actor(request)
    db.audit(u, ip, action, detail)


def since(range_key):
    return time.time() - RANGE_SECONDS.get(range_key, 300)


def secs(range_key):
    return RANGE_SECONDS.get(range_key, 300)


# ============================================================== bloco 2
def need_admin(request: Request):
    if request.scope["state"].get("role") != "admin":
        raise HTTPException(403, "Somente administradores")


# ============================================================== mapa da rede (v3.5)
def _is_private_host(host):
    import ipaddress
    from urllib.parse import urlparse
    h = str(host or "")
    if "://" in h:
        h = urlparse(h).hostname or ""
    try:
        ip = ipaddress.ip_address(h)
        return ip.is_private or ip.is_loopback or ip.is_link_local
    except ValueError:
        return h.endswith((".lan", ".local", ".home", ".internal")) or "." not in h
