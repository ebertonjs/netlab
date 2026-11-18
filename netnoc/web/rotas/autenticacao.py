"""Login, logout e informações da tela de login."""
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from netnoc.coleta import monitor
from netnoc.nucleo import db, security
from netnoc.web.comum import APP_VERSION

router = APIRouter()


class LoginIn(BaseModel):
    user: str
    password: str
    remember: bool = False


def _same_origin(request: Request):
    if request.headers.get("x-netnoc") != "1":
        return False
    o = request.headers.get("origin")
    return not o or o.split("://", 1)[-1] == request.headers.get("host", "")


@router.get("/login")
def login_page():
    return FileResponse("static/login.html", headers={"Cache-Control": "no-store"})


@router.get("/api/loginfo")
def loginfo():
    return {"name": monitor.get_app_name(), "version": APP_VERSION, "auth": not security.AUTH_OFF}


@router.post("/api/login")
def login_ep(data: LoginIn, request: Request):
    if not _same_origin(request):
        raise HTTPException(403, "Origem inválida")
    ip = (request.client.host if request.client else "?")
    user = data.user.strip()
    if security.rate_limited(ip, user):
        raise HTTPException(429, "Muitas tentativas. Aguarde alguns minutos.")
    role = security.verify(user, data.password)
    if role is None:
        security.register_fail(ip, user)
        db.audit(user[:40], ip, "login_falhou", "")
        raise HTTPException(401, "Usuário ou senha inválidos")
    ttl = security.SESSION_TTL_LONG if data.remember else security.SESSION_TTL
    resp = JSONResponse({"ok": True, "user": user, "role": role})
    secure = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
    resp.set_cookie(security.SESSION_COOKIE, security.make_session(user, ttl), max_age=ttl if data.remember else None,
                    httponly=True, samesite="strict", secure=secure, path="/")
    db.audit(user, ip, "login", "")
    return resp


@router.post("/api/logout")
def logout_ep(request: Request):
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(security.SESSION_COOKIE, path="/")
    return resp
