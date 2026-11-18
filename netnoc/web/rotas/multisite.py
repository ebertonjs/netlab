"""Agentes remotos (multi-site) e página de status público."""
import json, time
from typing import List

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from netnoc.coleta import monitor, sites
from netnoc.nucleo import db, security, stats
from netnoc.web.comum import audit, need_admin

router = APIRouter()


# ------------------------------------------------------------ multi-site
@router.get("/api/agent/config")
def agent_config(request: Request, site: str):
    if not sites.check_auth(request.headers.get("authorization")):
        raise HTTPException(401, "Token inválido")
    if not security.valid_name(site, 40):
        raise HTTPException(400, "Site inválido")
    return sites.agent_config(site)


class ReportIn(BaseModel):
    site: str
    rows: List[dict]


@router.post("/api/agent/report")
def agent_report(item: ReportIn, request: Request):
    if not sites.check_auth(request.headers.get("authorization")):
        raise HTTPException(401, "Token inválido")
    try:
        n = sites.ingest(item.site, item.rows)
    except (ValueError, TypeError) as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "accepted": n}


@router.post("/api/settings/agent-token")
def agent_token(request: Request):
    audit(request, "agent-token")
    return {"token": sites.new_token()}


@router.get("/api/sites")
def sites_ep():
    return {"sites": sites.sites_status(), "targets": sites.view()}


PS_DEFAULT = {"enabled": False, "title": "Status dos serviços", "targets": []}


def get_public_cfg():
    try:
        cfg = dict(PS_DEFAULT, **json.loads(db.get_setting("public_status", "{}") or "{}"))
    except Exception:
        cfg = dict(PS_DEFAULT)
    return cfg


@router.get("/api/settings/public-status")
def ps_get(request: Request):
    need_admin(request)
    return get_public_cfg()


class PublicStatusIn(BaseModel):
    enabled: bool
    title: str = "Status dos serviços"
    targets: List[str] = []


@router.post("/api/settings/public-status")
def ps_set(item: PublicStatusIn, request: Request):
    if not security.valid_name(item.title, 80):
        raise HTTPException(400, "Título inválido")
    known = {t["name"] for t in monitor.get_targets()}
    db.set_setting("public_status", json.dumps({"enabled": item.enabled, "title": item.title.strip(),
                                                  "targets": [t for t in item.targets if t in known]}))
    stats.cache_clear()
    audit(request, "public-status", item.enabled)
    return {"ok": True}


@stats.ttl_cache(15)
def _public_payload():
    cfg = get_public_cfg()
    if not cfg["enabled"]:
        return None
    names = [t["name"] for t in monitor.get_targets() if not cfg["targets"] or t["name"] in cfg["targets"]]
    snap = monitor.window_snapshot()
    bars = stats.daily_bars(30, tuple(names)) if names else {}
    up24 = stats.uptime_pct(86400, names) if names else {}
    items = []
    for n in names:
        s = snap.get(n)
        items.append({"name": n, "online": s["online"] if s else None, "uptime_24h": up24.get(n),
                      "bars": bars.get(n, [])})
    if not items:
        overall = "unknown"
    elif all(i["online"] for i in items):
        overall = "ok"
    elif any(i["online"] for i in items):
        overall = "degraded"
    else:
        overall = "down"
    cutoff = time.time() - 7 * 86400
    inc = [{"target": i["target"], "type": i["type"], "started": i["started_ts"], "resolved": i["resolved_ts"]}
           for i in db.query("SELECT target,type,started_ts,resolved_ts FROM incidents WHERE type='offline' "
                             "AND (started_ts>=? OR resolved_ts IS NULL) ORDER BY started_ts DESC LIMIT 50", (cutoff,))
           if i["target"] in names]
    return {"app": monitor.get_app_name(), "title": cfg["title"], "overall": overall, "updated": time.time(), "targets": items, "incidents": inc}


@router.get("/api/public/status")
def public_status():
    p = _public_payload()
    if p is None:
        raise HTTPException(404, "Página de status desativada")
    return p
