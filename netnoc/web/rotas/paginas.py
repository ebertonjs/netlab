"""Páginas HTML: interface v3, clássica, status público e manifesto do PWA."""
import json

from fastapi import APIRouter
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse

from netnoc.coleta import monitor

router = APIRouter()


@router.get("/manifest.webmanifest")
def manifest_ep():
    name = monitor.get_app_name()
    with open("static/manifest.webmanifest", encoding="utf-8") as fh:
        m = json.load(fh)
    m["name"] = name
    m["short_name"] = name[:12]
    return JSONResponse(m, media_type="application/manifest+json", headers={"Cache-Control": "no-cache"})


# ------------------------------------------------------------ interface v3
@router.get("/")
def app_page():
    return FileResponse("static/app.html", headers={"Cache-Control": "no-cache"})


@router.get("/index.html")
def old_index_redirect():
    """Favoritos/autocompletar antigos (/index.html) abrem a interface nova; a clássica fica em /classic."""
    return RedirectResponse("/", status_code=302)


@router.get("/classic")
def classic_page():
    """Interface antiga (configurações avançadas: SNMP, notificações, usuários, backup...)."""
    return FileResponse("static/index.html", headers={"Cache-Control": "no-cache"})


@router.get("/status")
def status_page():
    return FileResponse("static/status.html")
