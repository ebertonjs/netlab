"""Saúde, versão, usuários, auditoria, backup, Prometheus, dados do histórico e configurações gerais."""
import json, os, time
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse, Response
from pydantic import BaseModel

from netnoc.coleta import monitor
from netnoc.nucleo import backup, db, guarda, security, stats
from netnoc.web.comum import APP_VERSION, audit, need_admin, STARTED_AT
from netnoc.web.rotas.ferramentas import certs_ep

router = APIRouter()


@router.get("/healthz")
def healthz():
    """Público e barato. 503 quando o banco não responde ou um laço essencial parou: o
    netnoc-watchdog.timer reinicia o serviço depois de 3 falhas seguidas."""
    ok, det = guarda.health()
    return JSONResponse({"ok": ok, "problems": det["problems"]}, status_code=200 if ok else 503)


@router.get("/api/me")
def me(request: Request):
    st = request.scope.get("state", {})
    return {"user": st.get("user"), "role": st.get("role"), "version": APP_VERSION}


# ---------------------------------------------------------------- preferências por usuário (v3.14)
_PREF_KEYS = {"home"}


def _pref_key(request: Request):
    u = (request.scope.get("state", {}).get("user") or "anon")[:40]
    return "ui_prefs:" + u


@router.get("/api/me/prefs")
def prefs_get(request: Request):
    """Arrumação da página inicial (ordem, blocos recolhidos/escondidos) do usuário logado."""
    try:
        return json.loads(db.get_setting(_pref_key(request), "{}") or "{}")
    except ValueError:
        return {}


@router.post("/api/me/prefs")
async def prefs_set(request: Request):
    """Liberado também para o perfil visualizador: só mexe nas preferências da própria pessoa."""
    try:
        data = await request.json()
    except ValueError:
        raise HTTPException(400, "JSON inválido")
    if not isinstance(data, dict) or set(data) - _PREF_KEYS:
        raise HTTPException(400, "Preferência desconhecida")
    raw = json.dumps(data, separators=(",", ":"))
    if len(raw) > 4000:
        raise HTTPException(400, "Preferências grandes demais")
    db.set_setting(_pref_key(request), raw)
    return {"ok": True}


@router.get("/api/settings")
def get_settings():
    return {"targets": monitor.get_targets(), "dns_servers": monitor.get_dns_servers()}


# ------------------------------------------------------------------ escrita
class IntervalsIn(BaseModel):
    ping_interval_seconds: Optional[int] = None
    dns_check_interval_seconds: Optional[int] = None
    public_ip_interval_seconds: Optional[int] = None
    system_interval_seconds: Optional[int] = None


@router.get("/api/settings/intervals")
def get_intervals_ep():
    return monitor.get_intervals()


@router.post("/api/settings/intervals")
def set_intervals_ep(data: IntervalsIn, request: Request):
    try:
        monitor.set_intervals(data.dict())
    except ValueError as e:
        raise HTTPException(400, str(e))
    audit(request, "intervals", data.dict())
    return {"ok": True}


class AppNameIn(BaseModel):
    name: str


@router.get("/api/settings/appname")
def get_appname_ep():
    return {"name": monitor.get_app_name(), "version": APP_VERSION}


@router.post("/api/settings/appname")
def set_appname_ep(data: AppNameIn, request: Request):
    try:
        monitor.set_app_name(data.name)
    except ValueError as e:
        raise HTTPException(400, str(e))
    audit(request, "appname", data.name)
    return {"ok": True, "name": data.name.strip(), "version": APP_VERSION}


@router.post("/api/history/clear")
def clear_history(request: Request):
    db.clear_history()
    with monitor._state_lock:
        monitor._active_incidents.clear()
        monitor._last_latency.clear()
        monitor._win.clear()
        monitor._consec.clear()
        monitor._pending.clear()
        monitor._clean_since.clear()
    stats.cache_clear()
    monitor.log_event("Histórico limpo pelo usuário", "Info")
    audit(request, "history-clear")
    monitor.system_once()                   # atualiza os tamanhos mostrados na tela
    return {"ok": True, "history_mb": round(db.sizes()["history"] / 1e6, 2)}


@router.post("/api/history/vacuum")
def vacuum_history(request: Request):
    size = lambda: sum(db.sizes().values())
    before = size()
    db.vacuum_full()
    after = size()
    monitor.log_event(f"Banco compactado: {before/1e6:.1f}MB → {after/1e6:.1f}MB", "Info")
    audit(request, "vacuum")
    return {"ok": True, "size_before_mb": round(before / 1e6, 2), "size_after_mb": round(after / 1e6, 2)}


# ---------------------------------------------------------------- usuários/audit
class UserIn(BaseModel):
    name: str
    password: str
    role: str = "viewer"


@router.get("/api/users")
def users_list(request: Request):
    if request.scope["state"].get("role") != "admin":
        raise HTTPException(403, "Somente administradores")
    return security.list_users()


@router.post("/api/users")
def users_set(item: UserIn, request: Request):
    if not security.valid_name(item.name, 32) or item.role not in ("admin", "viewer"):
        raise HTTPException(400, "Usuário/perfil inválido")
    if len(item.password) < 8:
        raise HTTPException(400, "Senha deve ter ao menos 8 caracteres")
    security.set_user(item.name, item.password, item.role)
    audit(request, "user-set", f"{item.name}:{item.role}")
    return {"ok": True}


@router.delete("/api/users/{name}")
def users_del(name: str, request: Request):
    try:
        security.delete_user(name)
    except ValueError as e:
        raise HTTPException(400, str(e))
    audit(request, "user-del", name)
    return {"ok": True}


@router.get("/api/audit")
def audit_list(request: Request, limit: int = 100, user: str = "", q: str = "", hours: float = 0, kind: str = ""):
    """Registro de auditoria com filtros: usuário exato, texto na ação/detalhe, últimas N horas e
    tipo (login = entradas/saídas/falhas; negado = 403/erros; config = o resto)."""
    if request.scope["state"].get("role") != "admin":
        raise HTTPException(403, "Somente administradores")
    where, args = [], []
    if user:
        where.append("user = ?"); args.append(user[:40])
    if q:
        where.append("(action LIKE ? OR detail LIKE ?)"); args += [f"%{q[:60]}%"] * 2
    if hours and hours > 0:
        where.append("ts >= ?"); args.append(time.time() - min(hours, 24 * 400) * 3600)
    if kind == "login":
        where.append("action IN ('login', 'login_falhou', 'logout')")
    elif kind == "negado":
        where.append("(detail LIKE 'negado%' OR detail LIKE 'erro%' OR action = 'login_falhou')")
    elif kind == "config":
        where.append("action NOT IN ('login', 'login_falhou', 'logout')")
    sql = "SELECT * FROM audit_log" + (" WHERE " + " AND ".join(where) if where else "") + " ORDER BY ts DESC LIMIT ?"
    return db.query(sql, tuple(args) + (max(1, min(limit, 1000)),))


@router.get("/api/audit/users")
def audit_users(request: Request):
    need_admin(request)
    return [r["user"] for r in db.query("SELECT DISTINCT user FROM audit_log WHERE ts >= ? ORDER BY user",
                                         (time.time() - 90 * 86400,))]


@router.get("/api/security/secrets")
def secrets_inventory(request: Request):
    """Quais segredos existem e se estão cifrados em repouso (nunca devolve os valores)."""
    need_admin(request)
    from netnoc.nucleo import cofre
    return cofre.inventory()


# ---------------------------------------------------- backup / restauração
@router.get("/api/backup")
def backup_get(request: Request):
    need_admin(request)
    audit(request, "backup")
    body = json.dumps(backup.export_cfg(), ensure_ascii=False, indent=1)
    return Response(body.encode("utf-8"), media_type="application/json",
                    headers={"Content-Disposition": 'attachment; filename="netnoc-backup.json"'})


@router.post("/api/restore")
def restore_post(data: dict, request: Request):
    try:
        applied = backup.import_cfg(data)
    except backup.BackupError as e:
        raise HTTPException(400, str(e))
    stats.cache_clear()
    audit(request, "restore", ",".join(applied))
    return {"ok": True, "applied": applied}


# ---------------------------------------------- rede de segurança (v4.2)
class GuardaIn(BaseModel):
    backup_enabled: bool = True
    backup_time: str = "03:30"
    backup_hist: bool = False
    hc_url: str = ""


@router.get("/api/settings/guarda")
def guarda_get(request: Request):
    need_admin(request)
    from netnoc.coleta import monitor
    tg = monitor.get_telegram()
    key = security._KEY_FILE
    return {**security.mask_cfg(guarda.get_cfg(), guarda.SECRET), "last_backup": guarda.last_backup(),
            "hc": guarda.hc_status(), "telegram_ok": bool(tg["bot_token"] and tg["chat_id"]),
            "key_path": os.path.abspath(key) if not os.environ.get("NETNOC_SECRET_KEY") else None}


@router.post("/api/settings/guarda")
def guarda_set(data: GuardaIn, request: Request):
    need_admin(request)
    old = guarda.get_cfg()
    new = data.dict()
    if new["hc_url"] == security.MASK:
        new["hc_url"] = old["hc_url"]
    try:
        guarda.set_cfg(new)
    except ValueError as e:
        raise HTTPException(400, str(e))
    audit(request, "guarda", f"backup {'on' if new['backup_enabled'] else 'off'} {new['backup_time']}, vigia {'on' if new['hc_url'] else 'off'}")
    if new["hc_url"]:
        ok, det = guarda.health()
        guarda.hc_ping(ok, "; ".join(det["problems"]))        # já testa a URL
    return {"ok": True, "hc": guarda.hc_status()}


@router.post("/api/backup/run")
def backup_run(request: Request):
    need_admin(request)
    audit(request, "backup-telegram")
    r = guarda.run_backup("manual")
    if not r["ok"]:
        raise HTTPException(400, r["error"])
    return r


# -------------------------------------------------------------- Prometheus
def _lbl(v):
    return str(v).replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


@router.get("/metrics")
def metrics():
    snap = monitor.window_snapshot()
    L = ["# HELP netnoc_target_up 1 se o alvo responde", "# TYPE netnoc_target_up gauge"]
    for t in monitor.get_targets():
        s = snap.get(t["name"])
        if s:
            lb = f'{{target="{_lbl(t["name"])}",host="{_lbl(t["host"])}",type="{t.get("type", "icmp")}"}}'
            L.append(f"netnoc_target_up{lb} {1 if s['online'] else 0}")
    L += ["# TYPE netnoc_target_latency_ms gauge"]
    for n, s in snap.items():
        if s["latency"] is not None:
            L.append(f'netnoc_target_latency_ms{{target="{_lbl(n)}"}} {s["latency"]:.3f}')
    L += ["# TYPE netnoc_target_jitter_ms gauge", "# TYPE netnoc_target_loss_percent gauge"]
    for n, s in snap.items():
        L.append(f'netnoc_target_jitter_ms{{target="{_lbl(n)}"}} {s["avg_jitter"]:.3f}')
        L.append(f'netnoc_target_loss_percent{{target="{_lbl(n)}"}} {s["loss_pct"]:.2f}')
    inc = db.query("SELECT severity, COUNT(*) c FROM incidents WHERE resolved_ts IS NULL GROUP BY severity")
    L.append("# TYPE netnoc_incidents_active gauge")
    for r in inc:
        L.append(f'netnoc_incidents_active{{severity="{_lbl(r["severity"])}"}} {r["c"]}')
    m = {r["key"]: r["value"] for r in db.query(
        "SELECT key,value FROM meta WHERE key IN ('cpu_pct','mem_pct','temp_c')")}
    for k, name in (("cpu_pct", "netnoc_host_cpu_percent"), ("mem_pct", "netnoc_host_mem_percent"),
                    ("temp_c", "netnoc_host_temp_celsius")):
        if m.get(k) is not None:
            L.append(f"{name} {float(m[k])}")
    L.append("# TYPE netnoc_worker_ok gauge")
    for w in monitor.worker_health():
        L.append(f'netnoc_worker_ok{{worker="{_lbl(w["name"])}"}} {1 if w["status"] == "ok" else 0}')
    L.append("# TYPE netnoc_cert_days_left gauge")
    for n, d in certs_ep().items():
        if d is not None:
            L.append(f'netnoc_cert_days_left{{target="{_lbl(n)}"}} {d}')
    return PlainTextResponse("\n".join(L) + "\n", media_type="text/plain; version=0.0.4")


@router.post("/api/settings/metrics-token")
def metrics_token(request: Request):
    t = security.new_token()
    db.set_setting("metrics_token_hash", security.token_hash(t))
    audit(request, "metrics-token")
    return {"token": t}


# ------------------------------------------------------------ aparência (skins)
UI_SKINS = {"pro": ("dark", "light", "auto")}      # v4.0: um tema só (escuro, claro ou automático pelo horário)
UI_DEFAULT = {"skin": "pro", "mode": "dark", "accent": "#6750a4"}


@router.get("/api/settings/ui")
def ui_get():
    """Skin padrão do servidor (cada aparelho pode sobrescrever localmente)."""
    try:
        d = dict(UI_DEFAULT, **json.loads(db.get_setting("ui_default", "{}") or "{}"))
    except Exception:
        d = dict(UI_DEFAULT)
    if d.get("skin") not in UI_SKINS or d.get("mode") not in UI_SKINS["pro"]:      # tema antigo (v3) → Pro
        d = {"skin": "pro", "mode": "light" if d.get("mode") == "light" else "dark", "accent": d.get("accent", "#6750a4")}
    return d


class UiIn(BaseModel):
    skin: str
    mode: str
    accent: str = "#6750a4"


@router.post("/api/settings/ui")
def ui_set(item: UiIn, request: Request):
    import re as _re
    if item.skin not in UI_SKINS or item.mode not in UI_SKINS[item.skin]:
        raise HTTPException(400, "Skin ou modo inválido")
    if not _re.fullmatch(r"#[0-9a-fA-F]{6}", item.accent or ""):
        raise HTTPException(400, "Cor inválida (use #RRGGBB)")
    db.set_setting("ui_default", json.dumps({"skin": item.skin, "mode": item.mode, "accent": item.accent.lower()}))
    audit(request, "ui-default", f"{item.skin}/{item.mode}")
    return {"ok": True}


@router.get("/api/system")
def system_ep():
    m = {r["key"]: r["value"] for r in db.query(
        "SELECT key,value FROM meta WHERE key IN ('cpu_pct','mem_pct','temp_c','disk_pct','db_mb','db_cfg_mb','db_hist_mb','host_uptime_s')")}
    num = lambda v: float(v) if v not in (None, "") else None
    w = monitor.worker_health()
    return {"host_label": monitor.HOST_LABEL, "version": APP_VERSION, "app_uptime_s": int(time.time() - STARTED_AT),
            "cpu_pct": num(m.get("cpu_pct")), "mem_pct": num(m.get("mem_pct")), "temp_c": num(m.get("temp_c")),
            "disk_pct": num(m.get("disk_pct")), "db_mb": num(m.get("db_mb")),
            "db_cfg_mb": num(m.get("db_cfg_mb")), "db_hist_mb": num(m.get("db_hist_mb")),
            "db_files": {"config": os.path.basename(db.DB_PATH), "history": os.path.basename(db.HIST_PATH)},
            "host_uptime_s": num(m.get("host_uptime_s")),
            "workers": w, "workers_bad": [x["name"] for x in w if x["status"] != "ok"],
            "window_seconds": monitor.WINDOW_S}
