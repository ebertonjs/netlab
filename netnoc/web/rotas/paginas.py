"""Páginas HTML (interface, status público, manifesto do PWA) e a configuração do status público."""
import hashlib, json, os, re, time
from typing import List

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel

from netnoc.coleta import monitor
from netnoc.nucleo import db, security, stats
from netnoc.web.comum import audit, need_admin

router = APIRouter()


@router.get("/manifest.webmanifest")
def manifest_ep():
    name = monitor.get_app_name()
    with open("static/manifest.webmanifest", encoding="utf-8") as fh:
        m = json.load(fh)
    m["name"] = name
    m["short_name"] = name[:12]
    return JSONResponse(m, media_type="application/manifest+json", headers={"Cache-Control": "no-cache"})


# ------------------------------------------------------------ impressão digital dos arquivos (v3.14)
# Cada <script src>/<link href> local da página sai com ?v=<hash do conteúdo>. Assim o navegador
# guarda os arquivos por um ano (cache "imutável", ver web/middleware.py) e só baixa de novo o que
# realmente mudou — bom para enlaces lentos (rádio, satélite, 4G) — sem depender de alguém lembrar
# de trocar o número da versão à mão.
_ASSET = re.compile(r'((?:src|href)=")(?!https?:|//|data:|#)([^"?#]+\.(?:js|css|png|svg|woff2|jpg|webmanifest))(?:\?v=[^"]*)?(")')
_fp_cache = {}
_page_cache = {}


def _fingerprint(rel):
    p = os.path.join("static", rel.lstrip("/"))
    try:
        st = os.stat(p)
    except OSError:
        return None
    k = (p, st.st_mtime_ns, st.st_size)
    v = _fp_cache.get(k)
    if v is None:
        with open(p, "rb") as fh:
            v = hashlib.sha1(fh.read()).hexdigest()[:10]
        _fp_cache[k] = v
    return v


def versioned_page(path):
    st = os.stat(path)
    key = (path, st.st_mtime_ns)
    hit = _page_cache.get(path)
    html = None
    if hit and hit[0] == key:
        html, deps = hit[1], hit[2]
        if all(_fingerprint(d) == v for d, v in deps):
            return html
    with open(path, encoding="utf-8") as fh:
        src = fh.read()
    deps = []

    def sub(m):
        if m.group(2).endswith("manifest.webmanifest"):
            return m.group(0)           # o manifesto é gerado (nome do app) e sempre revalida
        v = _fingerprint(m.group(2))
        if not v:
            return m.group(0)
        deps.append((m.group(2), v))
        return f"{m.group(1)}{m.group(2)}?v={v}{m.group(3)}"
    html = _ASSET.sub(sub, src)
    _page_cache[path] = (key, html, deps)
    return html


def _page(path):
    try:
        return HTMLResponse(versioned_page(path), headers={"Cache-Control": "no-cache"})
    except Exception as e:          # nunca deixa a página principal fora do ar por causa disso
        print(f"[paginas] versão dos arquivos: {e}", flush=True)
        return FileResponse(path, headers={"Cache-Control": "no-cache"})


# ------------------------------------------------------------ interface v3
@router.get("/")
def app_page():
    return _page("static/app.html")


@router.get("/index.html")
@router.get("/classic")
def old_pages_redirect():
    """Favoritos antigos (/index.html e a interface clássica, removida na v4.0) abrem a interface."""
    return RedirectResponse("/", status_code=302)


@router.get("/status")
def status_page():
    return FileResponse("static/status.html")


# ------------------------------------------------------------ status público
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
