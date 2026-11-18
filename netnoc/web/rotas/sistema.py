"""Saúde, versão, usuários, auditoria, backup, Prometheus, dados do histórico e configurações gerais."""
import json, os, time
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import PlainTextResponse, Response
from pydantic import BaseModel

from netnoc.coleta import monitor
from netnoc.nucleo import backup, db, security, stats
from netnoc.web.comum import APP_VERSION, audit, need_admin, STARTED_AT
from netnoc.web.rotas.ferramentas import certs_ep

router = APIRouter()


@router.get("/healthz")
def healthz():
    return {"ok": True}


@router.get("/api/me")
def me(request: Request):
    st = request.scope.get("state", {})
    return {"user": st.get("user"), "role": st.get("role"), "version": APP_VERSION}


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
def audit_list(request: Request, limit: int = 100):
    if request.scope["state"].get("role") != "admin":
        raise HTTPException(403, "Somente administradores")
    return db.query("SELECT * FROM audit_log ORDER BY ts DESC LIMIT ?", (max(1, min(limit, 1000)),))


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
UI_SKINS = {"pro": ("dark", "light"), "glass": ("dark", "light"), "terminal": ("verde", "ambar", "ciano"),
            "grafana": ("dark", "light"), "material": ("light", "dark"), "lagoa": ("lagoa", "noite")}
UI_DEFAULT = {"skin": "pro", "mode": "dark", "accent": "#6750a4"}


@router.get("/api/settings/ui")
def ui_get():
    """Skin padrão do servidor (cada aparelho pode sobrescrever localmente)."""
    try:
        d = dict(UI_DEFAULT, **json.loads(db.get_setting("ui_default", "{}") or "{}"))
    except Exception:
        d = dict(UI_DEFAULT)
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


class SpeedAutoIn(BaseModel):
    enabled: bool
    time: str = "04:30"


@router.get("/api/settings/speedtest")
def speed_auto_get():
    return monitor.get_speedtest_auto()


@router.post("/api/settings/speedtest")
def speed_auto_set(item: SpeedAutoIn, request: Request):
    try:
        monitor.set_speedtest_auto(item.enabled, item.time)
    except ValueError as e:
        raise HTTPException(400, str(e))
    audit(request, "speedtest-auto", f"{item.enabled} {item.time}")
    return {"ok": True}


@router.get("/api/health/workers")
def workers_ep():
    return monitor.worker_health()


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
