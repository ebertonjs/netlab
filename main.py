import asyncio, json, os, time
from contextlib import asynccontextmanager
from typing import List, Optional

from fastapi import FastAPI, HTTPException, Request, WebSocket
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import backup
import checks
import db
import dvr
import monitor
import notifier
import security
import sites
import sla
import snmp
import stats
import zabbix

CFG = monitor.CFG
APP_VERSION = "3.6"
STARTED_AT = time.time()

RANGE_SECONDS = {"5m": 300, "1h": 3600, "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400}


def startup():
    monitor.start_all()
    dvr.start()
    pw = security.ensure_admin()
    if pw:
        banner = "=" * 60
        print(f"\n{banner}\n NetNOC: usuário inicial 'admin'  senha: {pw}\n"
              f" (altere em Configurações → Segurança ou: python manage.py set-password admin)\n{banner}\n", flush=True)
    if security.AUTH_OFF:
        print("AVISO: autenticação DESLIGADA (NETNOC_AUTH=off)", flush=True)


@asynccontextmanager
async def lifespan(_app):
    startup()          # on_event("startup") está deprecated
    yield
    dvr.shutdown()     # encerra o go2rtc junto com o NetNOC


app = FastAPI(title="NetNOC", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
app.add_middleware(security.AuthMiddleware)


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


@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.get("/api/me")
def me(request: Request):
    st = request.scope.get("state", {})
    return {"user": st.get("user"), "role": st.get("role"), "version": APP_VERSION}


# ------------------------------------------------------------------ leitura
def build_overview():
    snap = monitor.window_snapshot()
    latest = {n: {k: v for k, v in s.items() if k not in ("samples", "jitter")} for n, s in snap.items()}
    onl = list(latest.values())
    lats = [v["avg_latency"] for v in onl if v["avg_latency"] is not None]
    jits = [v["avg_jitter"] for v in onl]
    losses = [v["loss_pct"] for v in onl]
    last_speed = db.query("SELECT * FROM speedtests ORDER BY ts DESC LIMIT 1")
    m = {r["key"]: r["value"] for r in db.query(
        "SELECT key,value FROM meta WHERE key IN ('public_ip','public_ipv6','cpu_pct','mem_pct','temp_c')")}
    return {
        "internet_online": any(v["online"] for v in onl) if onl else False,
        "public_ip": m.get("public_ip"), "public_ipv6": m.get("public_ipv6"),
        "avg_latency": round(sum(lats) / len(lats), 1) if lats else None,
        "avg_jitter": round(sum(jits) / len(jits), 1) if jits else None,
        "avg_loss_pct": round(sum(losses) / len(losses), 2) if losses else None,
        "speedtest": last_speed[0] if last_speed else None,
        "cpu_pct": m.get("cpu_pct"), "mem_pct": m.get("mem_pct"), "temp_c": m.get("temp_c"),
        "targets": latest,
    }


_ov = [0.0, None]


@app.get("/api/overview")
def overview():
    if time.time() - _ov[0] > 2 or _ov[1] is None:
        _ov[1] = build_overview()
        _ov[0] = time.time()
    return _ov[1]


@app.get("/api/ping/history")
def ping_history(range: str = "5m"):
    s = stats.series(secs(range))
    return {t["name"]: [{"ts": r["ts"], "latency": r["latency"], "jitter": r["jitter"],
                         "loss_pct": r["loss_pct"]} for r in s.get(t["name"], [])]
            for t in monitor.get_targets()}


@app.get("/api/loss/history")
def loss_history(range: str = "5m"):
    s = stats.series(secs(range))
    return {t["name"]: [{"ts": r["ts"], "success": 0 if r["loss_pct"] >= 50 else 1,
                         "loss_pct": r["loss_pct"]} for r in s.get(t["name"], [])]
            for t in monitor.get_targets()}


@stats.ttl_cache(10)
def _targets_payload():
    snap = monitor.window_snapshot()
    up = stats.uptime_pct(86400)
    first = {r["target"]: r["mn"] for r in db.query("SELECT target, MIN(ts) mn FROM pings GROUP BY target")}
    last_fail = {r["target"]: r["mx"] for r in db.query(
        "SELECT target, MAX(ts) mx FROM pings WHERE success=0 GROUP BY target")}
    out = []
    for t in monitor.get_targets():
        n = t["name"]
        s = snap.get(n)
        if s:
            out.append({"name": n, "host": t["host"], "type": t.get("type", "icmp"),
                        "online": s["online"], "latency": s["latency"], "jitter": s["jitter"],
                        "loss_pct": round(s["loss_pct"], 2), "uptime_24h": up.get(n),
                        "since": first.get(n), "last_fail": last_fail.get(n), "group": t.get("group")})
        else:
            out.append({"name": n, "host": t["host"], "type": t.get("type", "icmp"),
                        "online": None, "uptime_24h": None})
    return out


@app.get("/api/targets")
def targets():
    return _targets_payload()


@app.get("/api/uptime/bars")
def uptime_bars(hours: int = 24):
    hours = max(1, min(hours, 168))
    bars = stats.hourly_bars(hours)
    return {t["name"]: bars.get(t["name"], []) for t in monitor.get_targets()}


@app.get("/api/sparklines")
def sparklines():
    return stats.sparklines()


@app.get("/api/insights/patterns")
def insights_patterns(days: int = 30):
    return monitor.detect_patterns(max(1, min(days, 365)))


@app.get("/api/dns")
def dns_status():
    rows = {r["server"]: r for r in db.query(
        "SELECT d.server, d.latency, d.success FROM dns_checks d JOIN "
        "(SELECT server, MAX(ts) mts FROM dns_checks WHERE ts>=? GROUP BY server) x "
        "ON x.server=d.server AND x.mts=d.ts", (time.time() - 3600,))}
    out = []
    for s in monitor.get_dns_servers():
        r = rows.get(s["name"])
        out.append({"name": s["name"], "ip": s["ip"], "latency": r["latency"] if r else None,
                    "success": bool(r["success"]) if r else None})
    return out


@app.get("/api/dns/history")
def dns_history(range: str = "1h"):
    s = secs(range) if range in RANGE_SECONDS else 3600
    b = 60 if s <= 3600 else (300 if s <= 86400 else (1800 if s <= 7 * 86400 else 3600))
    rows = db.query(
        f"SELECT server, CAST(ts/{b} AS INTEGER)*{b} t, AVG(CASE WHEN success=1 THEN latency END) lat, "
        f"100.0*SUM(success)/COUNT(*) ok FROM dns_checks WHERE ts>=? GROUP BY server, t ORDER BY server, t",
        (time.time() - s,))
    out = {}
    for r in rows:
        out.setdefault(r["server"], []).append({"ts": r["t"], "latency": r["lat"], "ok_pct": round(r["ok"], 1)})
    return out


@app.get("/api/incidents")
def incidents(active_only: bool = False, days: Optional[float] = None):
    where, params = [], []
    if active_only:
        where.append("resolved_ts IS NULL")
    if days is not None:
        # inclui os que começaram antes mas ainda estavam abertos/terminaram dentro da janela
        cutoff = time.time() - max(0.01, min(days, 365)) * 86400
        where.append("(started_ts >= ? OR resolved_ts IS NULL OR resolved_ts >= ?)")
        params += [cutoff, cutoff]
    q = "SELECT * FROM incidents" + (" WHERE " + " AND ".join(where) if where else "")
    return db.query(q + " ORDER BY started_ts DESC LIMIT 500", params)


@app.get("/api/events")
def events(limit: int = 50):
    return db.query("SELECT * FROM events ORDER BY ts DESC LIMIT ?", (max(1, min(limit, 500)),))


@app.get("/api/incidents/summary")
def incidents_summary(days: int = 7):
    rows = db.query("SELECT severity, COUNT(*) c FROM incidents WHERE started_ts >= ? GROUP BY severity",
                    (time.time() - days * 86400,))
    counts = {"Alta": 0, "Media": 0, "Baixa": 0, "Info": 0}
    for r in rows:
        counts[r["severity"]] = counts.get(r["severity"], 0) + r["c"]
    return counts


@app.get("/api/speedtest/history")
def speedtest_history(limit: int = 30):
    return db.query("SELECT * FROM speedtests ORDER BY ts DESC LIMIT ?", (max(1, min(limit, 500)),))


@app.get("/api/history/24h")
def history_24h(metric: str = "latency"):
    if metric not in ("latency", "jitter", "loss_pct"):
        raise HTTPException(400, "Métrica inválida (latency, jitter, loss_pct)")
    s = stats.series(86400)
    # média entre alvos por bucket (antes o parâmetro metric era ignorado)
    acc = {}
    for rows in s.values():
        for r in rows:
            if r.get(metric) is not None:
                a = acc.setdefault(r["ts"], [0, 0])
                a[0] += r[metric]
                a[1] += 1
    return [{"ts": ts, metric: a[0] / a[1]} for ts, a in sorted(acc.items())]


@app.get("/api/topology")
def topology():
    return monitor.build_topology()


@app.get("/api/settings")
def get_settings():
    return {"targets": monitor.get_targets(), "dns_servers": monitor.get_dns_servers()}


# ------------------------------------------------------------- tempo real (SSE)
_snap_cache = [0.0, None]


def build_snapshot():
    if time.time() - _snap_cache[0] > 2 or _snap_cache[1] is None:
        _snap_cache[1] = {
            "ts": time.time(), "overview": overview(),
            "incidents": db.query("SELECT * FROM incidents WHERE resolved_ts IS NULL ORDER BY started_ts DESC LIMIT 200"),
        }
        _snap_cache[0] = time.time()
    return _snap_cache[1]


@app.get("/api/snapshot")
def snapshot():
    return build_snapshot()


@app.get("/api/stream")
async def stream(request: Request):
    async def gen():
        last = None
        n = 0
        while True:
            if await request.is_disconnected():
                break
            snap = await asyncio.get_event_loop().run_in_executor(None, build_snapshot)
            payload = json.dumps(snap, default=str)
            if payload != last:
                last = payload
                yield f"data: {payload}\n\n"
            else:
                n += 1
                if n % 10 == 0:
                    yield ": keepalive\n\n"
            await asyncio.sleep(2)
    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ------------------------------------------------------------------ escrita
class IntervalsIn(BaseModel):
    ping_interval_seconds: Optional[int] = None
    dns_check_interval_seconds: Optional[int] = None
    public_ip_interval_seconds: Optional[int] = None
    system_interval_seconds: Optional[int] = None


@app.get("/api/settings/intervals")
def get_intervals_ep():
    return monitor.get_intervals()


@app.post("/api/settings/intervals")
def set_intervals_ep(data: IntervalsIn, request: Request):
    try:
        monitor.set_intervals(data.dict())
    except ValueError as e:
        raise HTTPException(400, str(e))
    audit(request, "intervals", data.dict())
    return {"ok": True}


class TelegramIn(BaseModel):
    enabled: bool
    bot_token: str = ""
    chat_id: str = ""
    min_severity: str = "Alta"


@app.get("/api/settings/telegram")
def get_telegram_ep():
    return security.mask_cfg(monitor.get_telegram(), ("bot_token",))


@app.post("/api/settings/telegram")
def set_telegram_ep(data: TelegramIn, request: Request):
    if data.min_severity not in ("Alta", "Media", "Baixa", "Info"):
        raise HTTPException(400, "Severidade inválida")
    old = monitor.get_telegram()
    try:
        new = security.merge_secrets(old, data.dict(), ("bot_token",))
    except ValueError as e:
        raise HTTPException(400, str(e))
    monitor.set_telegram(new["enabled"], new["bot_token"], new["chat_id"], new["min_severity"])
    audit(request, "telegram")
    return {"ok": True}


@app.post("/api/settings/telegram/test")
def test_telegram_ep():
    if not monitor.send_telegram(f"✅ Teste de alerta {monitor.get_app_name()} — configuração funcionando!"):
        raise HTTPException(400, "Não foi possível enviar. Confira o token e chat_id.")
    return {"ok": True}


class MikrotikIn(BaseModel):
    enabled: bool
    host: str = ""
    port: int = 443
    use_https: bool = True
    verify_ssl: bool = False
    username: str = ""
    password: str = ""
    sync_interval_seconds: int = 60


def _check_hostport(host, port, enabled):
    if (host or enabled) and not security.valid_host(host):
        raise HTTPException(400, "Host inválido")
    if not security.valid_port(port):
        raise HTTPException(400, "Porta inválida")


@app.get("/api/settings/mikrotik")
def get_mikrotik_ep():
    return security.mask_cfg(monitor.get_mikrotik(), ("password",))


@app.post("/api/settings/mikrotik")
def set_mikrotik_ep(data: MikrotikIn, request: Request):
    _check_hostport(data.host, data.port, data.enabled)
    try:
        payload = security.merge_secrets(monitor.get_mikrotik(), data.dict(), ("password",),
                                         ("host", "port", "username", "use_https"))
    except ValueError as e:
        raise HTTPException(400, str(e))
    payload["sync_interval_seconds"] = max(15, int(payload["sync_interval_seconds"]))
    monitor.set_mikrotik(payload)
    audit(request, "mikrotik", payload["host"])
    if payload["enabled"]:
        monitor.sync_dhcp_leases()
    return {"ok": True}


@app.post("/api/settings/mikrotik/test")
def test_mikrotik_ep():
    try:
        leases = monitor.fetch_dhcp_leases()
    except Exception as e:
        raise HTTPException(400, f"Não foi possível conectar: {e}")
    monitor.sync_dhcp_leases()
    return {"ok": True, "leases_found": len(leases)}


@app.get("/api/mikrotik/status")
def mikrotik_status_ep():
    cfg = monitor.get_mikrotik()
    return {"enabled": cfg["enabled"], "host": cfg["host"], **(monitor.get_mikrotik_status() or {})}


@app.get("/api/mikrotik/interfaces")
def mikrotik_interfaces_ep():
    return monitor.get_mikrotik_interfaces()


@app.get("/api/mikrotik/history")
def mikrotik_history_ep(range: str = "1h", iface: Optional[str] = None):
    s = secs(range) if range in RANGE_SECONDS else 3600
    if iface:
        return {"type": "interface", "iface": iface, "points": monitor.get_mikrotik_iface_history(iface, s)}
    return {"type": "resource", "points": monitor.get_mikrotik_resource_history(s)}


class AghIn(BaseModel):
    enabled: bool
    host: str = ""
    port: int = 3000
    use_https: bool = False
    username: str = ""
    password: str = ""
    sync_interval_seconds: int = 60


@app.get("/api/settings/agh")
def get_agh_ep():
    return security.mask_cfg(monitor.get_agh(), ("password",))


@app.post("/api/settings/agh")
def set_agh_ep(data: AghIn, request: Request):
    _check_hostport(data.host, data.port, data.enabled)
    try:
        payload = security.merge_secrets(monitor.get_agh(), data.dict(), ("password",),
                                         ("host", "port", "username", "use_https"))
    except ValueError as e:
        raise HTTPException(400, str(e))
    payload["sync_interval_seconds"] = max(15, int(payload["sync_interval_seconds"]))
    monitor.set_agh(payload)
    audit(request, "agh", payload["host"])
    return {"ok": True}


@app.post("/api/settings/agh/test")
def test_agh_ep():
    try:
        st = monitor.test_agh_connection()
    except Exception as e:
        raise HTTPException(400, f"Não foi possível conectar: {e}")
    return {"ok": True, "version": st.get("version")}


@app.get("/api/agh/status")
def agh_status_ep():
    return monitor.get_agh_status() or {"enabled": False}


@app.get("/api/agh/stats")
def agh_stats_ep():
    return monitor.get_agh_stats_latest() or {}


@app.get("/api/agh/top")
def agh_top_ep():
    try:
        return monitor.get_agh_top()
    except Exception:
        return {"clients": [], "queried": [], "blocked": []}


@app.get("/api/agh/history")
def agh_history_ep(range: str = "1h"):
    return monitor.get_agh_stats_history(secs(range) if range in RANGE_SECONDS else 3600)


@app.get("/api/dhcp/hosts")
def dhcp_hosts_ep():
    return monitor.get_dhcp_hosts()


class PromoteIn(BaseModel):
    name: Optional[str] = None
    parent: Optional[str] = None


@app.post("/api/dhcp/hosts/{host_id}/promote")
def promote_dhcp_host_ep(host_id: int, item: PromoteIn, request: Request):
    try:
        name = monitor.promote_dhcp_host(host_id, item.name, item.parent)
    except ValueError as e:
        raise HTTPException(400, str(e))
    audit(request, "promote", name)
    return {"ok": True, "name": name}


@app.post("/api/speedtest/run")
def speedtest_run(request: Request):
    audit(request, "speedtest")
    try:
        return monitor.run_speedtest()
    except RuntimeError as e:
        raise HTTPException(409, str(e))


class TargetIn(BaseModel):
    name: str
    host: str
    parent: Optional[str] = None
    interval: Optional[int] = None
    type: str = "icmp"
    port: Optional[int] = None
    expect_status: Optional[int] = None
    verify_ssl: Optional[bool] = None
    sites: Optional[List[str]] = None
    group: Optional[str] = None


class DnsIn(BaseModel):
    name: str
    ip: str


class AppNameIn(BaseModel):
    name: str


@app.get("/api/settings/appname")
def get_appname_ep():
    return {"name": monitor.get_app_name(), "version": APP_VERSION}


@app.post("/api/settings/appname")
def set_appname_ep(data: AppNameIn, request: Request):
    try:
        monitor.set_app_name(data.name)
    except ValueError as e:
        raise HTTPException(400, str(e))
    audit(request, "appname", data.name)
    return {"ok": True, "name": data.name.strip(), "version": APP_VERSION}


@app.post("/api/settings/targets")
def create_target(item: TargetIn, request: Request):
    extra = {}
    if item.type != "icmp":
        extra["type"] = item.type
    if item.port is not None:
        extra["port"] = item.port
    if item.expect_status is not None:
        extra["expect_status"] = item.expect_status
    if item.verify_ssl is not None:
        extra["verify_ssl"] = item.verify_ssl
    if item.sites:
        extra["sites"] = item.sites
    if item.group and item.group.strip():
        extra["group"] = item.group.strip()
    if item.interval:
        if not 2 <= item.interval <= 3600:
            raise HTTPException(400, "Intervalo deve estar entre 2 e 3600 s")
        extra["interval"] = item.interval
    try:
        monitor.add_target(item.name, item.host, item.parent, extra)
    except ValueError as e:
        raise HTTPException(400, str(e))
    audit(request, "target+", item.name)
    return {"ok": True}


class TargetUpdateIn(BaseModel):
    parent: Optional[str] = None
    interval: Optional[int] = None
    group: Optional[str] = None
    set_parent: bool = False
    set_interval: bool = False
    set_group: bool = False


@app.post("/api/settings/targets/{name}/update")
def update_target_ep(name: str, item: TargetUpdateIn, request: Request):
    kw = {}
    if item.set_parent:
        kw["parent"] = item.parent
    if item.set_interval:
        kw["interval"] = item.interval
    if item.set_group:
        kw["group"] = item.group
    try:
        monitor.update_target(name, **kw)
    except ValueError as e:
        raise HTTPException(400, str(e))
    stats.cache_clear()
    audit(request, "target~", f"{name} {kw}")
    return {"ok": True}


@app.delete("/api/settings/targets/{name}")
def delete_target(name: str, request: Request):
    monitor.remove_target(name)
    audit(request, "target-", name)
    return {"ok": True}


@app.post("/api/settings/dns")
def create_dns(item: DnsIn, request: Request):
    try:
        monitor.add_dns(item.name, item.ip)
    except ValueError as e:
        raise HTTPException(400, str(e))
    audit(request, "dns+", item.name)
    return {"ok": True}


@app.delete("/api/settings/dns/{name}")
def delete_dns(name: str, request: Request):
    monitor.remove_dns(name)
    audit(request, "dns-", name)
    return {"ok": True}


@app.post("/api/history/clear")
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


@app.post("/api/history/vacuum")
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


@app.get("/api/users")
def users_list(request: Request):
    if request.scope["state"].get("role") != "admin":
        raise HTTPException(403, "Somente administradores")
    return security.list_users()


@app.post("/api/users")
def users_set(item: UserIn, request: Request):
    if not security.valid_name(item.name, 32) or item.role not in ("admin", "viewer"):
        raise HTTPException(400, "Usuário/perfil inválido")
    if len(item.password) < 8:
        raise HTTPException(400, "Senha deve ter ao menos 8 caracteres")
    security.set_user(item.name, item.password, item.role)
    audit(request, "user-set", f"{item.name}:{item.role}")
    return {"ok": True}


@app.delete("/api/users/{name}")
def users_del(name: str, request: Request):
    try:
        security.delete_user(name)
    except ValueError as e:
        raise HTTPException(400, str(e))
    audit(request, "user-del", name)
    return {"ok": True}


@app.get("/api/audit")
def audit_list(request: Request, limit: int = 100):
    if request.scope["state"].get("role") != "admin":
        raise HTTPException(403, "Somente administradores")
    return db.query("SELECT * FROM audit_log ORDER BY ts DESC LIMIT ?", (max(1, min(limit, 1000)),))


# ============================================================== bloco 2
def need_admin(request: Request):
    if request.scope["state"].get("role") != "admin":
        raise HTTPException(403, "Somente administradores")


# ------------------------------------------------------------ ferramentas
@app.get("/api/tools/traceroute")
def tool_traceroute(request: Request, host: str, max_hops: int = 20):
    need_admin(request)
    try:
        hops = checks.traceroute(host, max_hops)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except RuntimeError as e:
        raise HTTPException(500, str(e))
    audit(request, "traceroute", host)
    return {"host": host, "hops": hops}


@app.get("/api/tools/ipcompare")
def tool_ipcompare(request: Request, host: str):
    need_admin(request)
    try:
        res = checks.compare_ip_versions(host)
    except ValueError as e:
        raise HTTPException(400, str(e))
    audit(request, "ipcompare", host)
    return res


class DiscoverIn(BaseModel):
    cidr: str


@app.post("/api/tools/discover")
def tool_discover(item: DiscoverIn, request: Request):
    known = [t["host"] for t in monitor.get_targets()]
    try:
        jid = checks.start_discovery(item.cidr, known)
    except ValueError as e:
        raise HTTPException(400, str(e))
    audit(request, "discover", item.cidr)
    return {"job": jid}


@app.get("/api/tools/discover/{jid}")
def tool_discover_status(jid: str, request: Request):
    need_admin(request)
    st = checks.discovery_status(jid)
    if not st:
        raise HTTPException(404, "Varredura não encontrada")
    return st


@app.get("/api/certs")
def certs_ep():
    rows = db.query("SELECT key, value FROM meta WHERE key LIKE 'cert_days:%'")
    return {r["key"].split(":", 1)[1]: (float(r["value"]) if r["value"] not in ("", None) else None)
            for r in rows}


# ------------------------------------------------------------ notificações
@app.get("/api/settings/notify")
def notify_get(request: Request):
    need_admin(request)
    return notifier.masked_config()


@app.post("/api/settings/notify")
def notify_set(data: dict, request: Request):
    try:
        notifier.save_config(data)
    except ValueError as e:
        raise HTTPException(400, str(e))
    audit(request, "notify")
    return {"ok": True}


@app.post("/api/settings/notify/test/{channel}")
def notify_test(channel: str, request: Request):
    if channel not in notifier.CHANNELS:
        raise HTTPException(404, "Canal desconhecido")
    try:
        notifier.send_channel(channel, "Info", f"✅ Teste de alerta {monitor.get_app_name()} — canal funcionando!", None, "test")
    except Exception as e:
        raise HTTPException(400, f"Falha: {notifier._safe_err(e)}")
    audit(request, "notify-test", channel)
    return {"ok": True}


class MaintIn(BaseModel):
    name: str
    start: float
    end: float
    targets: Optional[List[str]] = None


@app.get("/api/maintenance")
def maint_list():
    return notifier.get_maintenance()


@app.post("/api/maintenance")
def maint_add(item: MaintIn, request: Request):
    try:
        m = notifier.add_maintenance(item.name, item.start, item.end, item.targets)
    except (ValueError, TypeError) as e:
        raise HTTPException(400, str(e))
    audit(request, "maintenance+", item.name)
    return m


@app.delete("/api/maintenance/{mid}")
def maint_del(mid: str, request: Request):
    notifier.remove_maintenance(mid)
    audit(request, "maintenance-", mid)
    return {"ok": True}


# -------------------------------------------------------------------- SNMP
@app.get("/api/settings/snmp")
def snmp_get(request: Request):
    need_admin(request)
    return snmp.masked_devices()


@app.post("/api/settings/snmp")
def snmp_set(data: List[dict], request: Request):
    try:
        snmp.save_devices(data)
    except (ValueError, KeyError, TypeError) as e:
        raise HTTPException(400, str(e))
    audit(request, "snmp", len(data))
    return {"ok": True}


def _snmp_dev(name):
    for d in snmp.get_devices():
        if d["name"] == name:
            return d
    raise HTTPException(404, "Dispositivo SNMP não encontrado")


@app.post("/api/snmp/test/{name}")
def snmp_test(name: str, request: Request):
    try:
        res = snmp.poll_device(_snmp_dev(name))
    except RuntimeError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "sysname": res.get("sysname"), "uptime_s": res.get("uptime_s"), "custom": res.get("custom")}


class WalkIn(BaseModel):
    device: str
    oid: str


@app.post("/api/snmp/walk")
def snmp_walk(item: WalkIn, request: Request):
    try:
        rows = snmp.walk(_snmp_dev(item.device), item.oid)
    except (ValueError, RuntimeError) as e:
        raise HTTPException(400, str(e))
    audit(request, "snmp-walk", f"{item.device} {item.oid}")
    return rows


@app.get("/api/snmp/latest")
def snmp_latest(device: Optional[str] = None):
    return snmp.latest(device)


@app.get("/api/snmp/history")
def snmp_history(device: str, key: str, range: str = "1h"):
    return snmp.history(device, key, secs(range) if range in RANGE_SECONDS else 3600)


# ------------------------------------------------------------------ Zabbix
@app.get("/api/settings/zabbix")
def zabbix_get(request: Request):
    need_admin(request)
    return zabbix.masked()


@app.post("/api/settings/zabbix")
def zabbix_set(data: dict, request: Request):
    try:
        zabbix.save_cfg(data)
    except (ValueError, TypeError) as e:
        raise HTTPException(400, str(e))
    audit(request, "zabbix", data.get("url"))
    return {"ok": True}


@app.post("/api/settings/zabbix/test")
def zabbix_test():
    try:
        return {"ok": True, "version": zabbix.test()}
    except Exception as e:
        raise HTTPException(400, f"Falha: {str(e)[:200]}")


@app.get("/api/zabbix/problems")
def zabbix_problems():
    return zabbix.problems()


# --------------------------------------------------------------------- SLA
def _sla_range(month, days):
    try:
        return sla.period_bounds(month, max(1, min(days, 365)))
    except (ValueError, IndexError):
        raise HTTPException(400, "Mês inválido (use AAAA-MM)")


@app.get("/api/sla")
def sla_ep(month: Optional[str] = None, days: int = 30):
    s, e = _sla_range(month, days)
    return sla.report(s, e)


@app.get("/api/sla.csv")
def sla_csv(request: Request, month: Optional[str] = None, days: int = 30):
    s, e = _sla_range(month, days)
    body = sla.to_csv(sla.report(s, e), monitor.get_app_name())
    return Response(body.encode("utf-8"), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": 'attachment; filename="sla-netnoc.csv"'})


# ------------------------------------------------------------ multi-site
@app.get("/api/agent/config")
def agent_config(request: Request, site: str):
    if not sites.check_auth(request.headers.get("authorization")):
        raise HTTPException(401, "Token inválido")
    if not security.valid_name(site, 40):
        raise HTTPException(400, "Site inválido")
    return sites.agent_config(site)


class ReportIn(BaseModel):
    site: str
    rows: List[dict]


@app.post("/api/agent/report")
def agent_report(item: ReportIn, request: Request):
    if not sites.check_auth(request.headers.get("authorization")):
        raise HTTPException(401, "Token inválido")
    try:
        n = sites.ingest(item.site, item.rows)
    except (ValueError, TypeError) as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "accepted": n}


@app.post("/api/settings/agent-token")
def agent_token(request: Request):
    audit(request, "agent-token")
    return {"token": sites.new_token()}


@app.get("/api/sites")
def sites_ep():
    return {"sites": sites.sites_status(), "targets": sites.view()}


# ---------------------------------------------------- backup / restauração
@app.get("/api/backup")
def backup_get(request: Request):
    need_admin(request)
    audit(request, "backup")
    body = json.dumps(backup.export_cfg(), ensure_ascii=False, indent=1)
    return Response(body.encode("utf-8"), media_type="application/json",
                    headers={"Content-Disposition": 'attachment; filename="netnoc-backup.json"'})


@app.post("/api/restore")
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


@app.get("/metrics")
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


@app.post("/api/settings/metrics-token")
def metrics_token(request: Request):
    t = security.new_token()
    db.set_setting("metrics_token_hash", security.token_hash(t))
    audit(request, "metrics-token")
    return {"token": t}



# ============================================================== bloco 3
@app.get("/api/heatmap")
def heatmap_ep(target: str, days: int = 14):
    if target not in {t["name"] for t in monitor.get_targets()}:
        raise HTTPException(404, "Alvo não encontrado")
    return stats.heatmap(target, days)


PS_DEFAULT = {"enabled": False, "title": "Status dos serviços", "targets": []}


def get_public_cfg():
    try:
        cfg = dict(PS_DEFAULT, **json.loads(db.get_setting("public_status", "{}") or "{}"))
    except Exception:
        cfg = dict(PS_DEFAULT)
    return cfg


@app.get("/api/settings/public-status")
def ps_get(request: Request):
    need_admin(request)
    return get_public_cfg()


class PublicStatusIn(BaseModel):
    enabled: bool
    title: str = "Status dos serviços"
    targets: List[str] = []


@app.post("/api/settings/public-status")
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


class LoginIn(BaseModel):
    user: str
    password: str
    remember: bool = False


def _same_origin(request: Request):
    if request.headers.get("x-netnoc") != "1":
        return False
    o = request.headers.get("origin")
    return not o or o.split("://", 1)[-1] == request.headers.get("host", "")


@app.get("/login")
def login_page():
    return FileResponse("static/login.html", headers={"Cache-Control": "no-store"})


@app.get("/api/loginfo")
def loginfo():
    return {"name": monitor.get_app_name(), "version": APP_VERSION, "auth": not security.AUTH_OFF}


@app.post("/api/login")
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


@app.post("/api/logout")
def logout_ep(request: Request):
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(security.SESSION_COOKIE, path="/")
    return resp


@app.get("/manifest.webmanifest")
def manifest_ep():
    name = monitor.get_app_name()
    with open("static/manifest.webmanifest", encoding="utf-8") as fh:
        m = json.load(fh)
    m["name"] = name
    m["short_name"] = name[:12]
    return JSONResponse(m, media_type="application/manifest+json", headers={"Cache-Control": "no-cache"})


# ------------------------------------------------------------ interface v3
@app.get("/")
def app_page():
    return FileResponse("static/app.html", headers={"Cache-Control": "no-cache"})


@app.get("/index.html")
def old_index_redirect():
    """Favoritos/autocompletar antigos (/index.html) abrem a interface nova; a clássica fica em /classic."""
    return RedirectResponse("/", status_code=302)


@app.get("/classic")
def classic_page():
    """Interface antiga (configurações avançadas: SNMP, notificações, usuários, backup...)."""
    return FileResponse("static/index.html", headers={"Cache-Control": "no-cache"})


# ------------------------------------------------------------ câmeras (DVR Intelbras)
@app.get("/api/settings/dvr")
def dvr_get(request: Request):
    need_admin(request)
    return dvr.masked()


@app.post("/api/settings/dvr")
def dvr_set(data: dict, request: Request):
    try:
        dvr.save_cfg(data)
    except (ValueError, TypeError) as e:
        raise HTTPException(400, str(e))
    audit(request, "dvr", data.get("host"))
    return {"ok": True}


@app.post("/api/settings/dvr/test")
def dvr_test(request: Request):
    try:
        return dvr.test()
    except Exception as e:
        raise HTTPException(400, f"Não foi possível falar com o DVR: {dvr._safe_err(e)}")


@app.get("/api/cam/status")
def cam_status():
    return dvr.status()


@app.get("/api/cam/viewers")
def cam_viewers():
    return {"viewers": dvr.viewers()}


@app.get("/api/cam/snapshot/{ch}")
def cam_snapshot(ch: int, last: bool = False, age: float = 2.0):
    """Foto do canal. last=1 devolve a última imagem boa guardada (sem tocar no DVR).
    age = idade máxima aceita da foto em cache (s): a página inicial usa ~50 s e várias telas abertas
    dividem a mesma foto em vez de cada uma acordar o DVR."""
    if last:
        lg = dvr.last_good(ch)
        if lg:
            return Response(lg[1], media_type="image/jpeg", headers={"Cache-Control": "no-store", "X-Snapshot-Ts": str(int(lg[0]))})
    try:
        data, ts = dvr.snapshot(ch, max_age=max(0.0, min(float(age), 120.0)))
    except ValueError as e:
        raise HTTPException(404, str(e))
    except Exception as e:
        raise HTTPException(502, f"DVR: {dvr._safe_err(e)}")
    return Response(data, media_type="image/jpeg", headers={"Cache-Control": "no-store", "X-Snapshot-Ts": str(int(ts))})


@app.websocket("/api/cam/ws")
async def cam_ws(websocket: WebSocket, src: str = ""):
    """Ponte navegador ⇄ go2rtc (localhost). Autenticação e origem já checadas no middleware.
    Do navegador só passa o pedido "mse" (lista de codecs); nenhum outro comando do go2rtc é exposto."""
    if not dvr.valid_src(src):
        await websocket.close(code=1008)
        return
    import websockets
    await websocket.accept()
    try:
        async with websockets.connect(f"ws://{dvr.GO2RTC_ADDR}/api/ws?src={src}", max_size=None,
                                      open_timeout=6, ping_interval=None, compression=None) as up:
            async def from_browser():
                while True:
                    m = await websocket.receive()
                    if m["type"] == "websocket.disconnect":
                        return
                    txt = m.get("text")
                    if txt:
                        try:
                            j = json.loads(txt)
                        except Exception:
                            continue
                        if j.get("type") == "mse" and isinstance(j.get("value"), str) and len(j["value"]) < 500:
                            await up.send(json.dumps({"type": "mse", "value": j["value"]}))

            async def from_go2rtc():
                async for m in up:
                    if isinstance(m, (bytes, bytearray)):
                        await websocket.send_bytes(bytes(m))
                    else:
                        await websocket.send_text(m)

            tasks = [asyncio.create_task(from_browser()), asyncio.create_task(from_go2rtc())]
            _, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for t in pending:
                t.cancel()
    except Exception as e:
        try:
            await websocket.send_text(json.dumps({"type": "error", "value": "vídeo indisponível: " + dvr._safe_err(e)}))
        except Exception:
            pass
    finally:
        try:
            await websocket.close()
        except Exception:
            pass


# ------------------------------------------------------------ aparência (skins)
UI_SKINS = {"glass": ("dark", "light"), "terminal": ("verde", "ambar", "ciano"),
            "grafana": ("dark", "light"), "material": ("light", "dark")}
UI_DEFAULT = {"skin": "glass", "mode": "dark", "accent": "#6750a4"}


@app.get("/api/settings/ui")
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


@app.post("/api/settings/ui")
def ui_set(item: UiIn, request: Request):
    import re as _re
    if item.skin not in UI_SKINS or item.mode not in UI_SKINS[item.skin]:
        raise HTTPException(400, "Skin ou modo inválido")
    if not _re.fullmatch(r"#[0-9a-fA-F]{6}", item.accent or ""):
        raise HTTPException(400, "Cor inválida (use #RRGGBB)")
    db.set_setting("ui_default", json.dumps({"skin": item.skin, "mode": item.mode, "accent": item.accent.lower()}))
    audit(request, "ui-default", f"{item.skin}/{item.mode}")
    return {"ok": True}


# ============================================================== página inicial (v3.4)
_OUTAGE_TYPES = ("offline", "local")


@stats.ttl_cache(60)
def _home_slow():
    """Partes caras da página inicial (disponibilidade 7/30 d, mapa de incidentes): cache de 60 s."""
    import datetime
    now = time.time()
    lt = time.localtime(now)
    midnight = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, 0, 0, -1))
    names = [t["name"] for t in monitor.get_targets()]

    def avg_up(seconds):
        up = stats.uptime_pct(seconds, names)
        v = [x for x in up.values() if x is not None]
        return round(sum(v) / len(v), 3) if v else None
    month0 = time.mktime((lt.tm_year, lt.tm_mon, 1, 0, 0, 0, 0, 0, -1))
    inc_m = db.query("SELECT started_ts, resolved_ts FROM incidents WHERE started_ts>=? AND type!='dns'", (month0,))
    dur = [r["resolved_ts"] - r["started_ts"] for r in inc_m if r["resolved_ts"]]
    # mapa 7 dias x 24 h (hora local) de incidentes de conectividade
    day0 = datetime.date.today() - datetime.timedelta(days=6)
    t0 = time.mktime(day0.timetuple())
    heat = [[0] * 24 for _ in range(7)]
    for r in db.query("SELECT started_ts FROM incidents WHERE started_ts>=? AND type IN "
                      "('offline','local','loss','latency','jitter')", (t0,)):
        d = datetime.datetime.fromtimestamp(r["started_ts"])
        di = (d.date() - day0).days
        if 0 <= di < 7:
            heat[di][d.hour] += 1
    return {
        "up_today": avg_up(max(300, now - midnight)), "up_7d": avg_up(7 * 86400), "up_30d": avg_up(30 * 86400),
        "month_incidents": len(inc_m), "month_mttr_s": round(sum(dur) / len(dur)) if dur else None,
        "heat": {"days": [(day0 + datetime.timedelta(days=i)).isoformat() for i in range(7)], "cells": heat},
    }


def _home_avail():
    th = monitor.THRESH
    targets = monitor.get_targets()
    parent = {t["name"]: t.get("parent") for t in targets}
    blocks = stats.availability_blocks(24, 1800)

    def state(n, ok, lat):
        if not n:
            return None
        loss = 100 * (1 - ok / n)
        if loss >= 50:
            return "bad"
        if loss >= th.get("loss_pct", 2) or (lat is not None and lat > th.get("ping_ms", 80)):
            return "warn"
        return "ok"
    raw = {t: [state(n, ok, lat) for (_, n, ok, lat) in rows] for t, rows in blocks.items()}
    out = []
    for t in targets:
        n = t["name"]
        rows = blocks.get(n, [])
        st = list(raw.get(n, []))
        p = parent.get(n)
        if p and p in raw:              # caiu junto com o pai: isolado, não "fora"
            st = ["iso" if s == "bad" and i < len(raw[p]) and raw[p][i] == "bad" else s for i, s in enumerate(st)]
        tot_n = sum(r[1] for r in rows)
        tot_ok = sum(r[2] for r in rows)
        out.append({"name": n, "parent": p, "pct": round(100 * tot_ok / tot_n, 2) if tot_n else None,
                    "blocks": [{"ts": r[0], "s": s, "lat": r[3], "loss": round(100 * (1 - r[2] / r[1]), 1) if r[1] else None}
                               for r, s in zip(rows, st)]})
    return out


def _home_network():
    cfg = monitor.get_mikrotik()
    if not cfg["enabled"]:
        return None
    st = monitor.get_mikrotik_status() or {}
    ifaces = [dict(i, comment=monitor._mt_comment.get(i["name"], "")) for i in monitor.get_mikrotik_interfaces()]
    hosts = monitor.get_dhcp_hosts()
    first_sync = min((h["first_seen"] for h in hosts if h["first_seen"]), default=None)
    now = time.time()
    active = [h for h in hosts if h["active"]]
    # "novo" = apareceu nas últimas 24 h e não fazia parte da primeira sincronização
    new = sorted([h for h in hosts if h["first_seen"] and now - h["first_seen"] < 86400
                  and first_sync is not None and h["first_seen"] - first_sync > 3600],
                 key=lambda h: -h["first_seen"])
    recent = sorted(active, key=lambda h: -(h["last_seen"] or 0))
    pick = new[:5] + [h for h in recent if h not in new][:max(0, 5 - len(new[:5]))]
    return {"status": st, "interfaces": ifaces, "active": len(active), "total": len(hosts), "new_24h": len(new),
            "hosts": [{"name": h["hostname"] or h["mac"], "ip": h["ip"], "new": h in new, "active": bool(h["active"]),
                       "first_seen": h["first_seen"], "last_seen": h["last_seen"]} for h in pick]}


def _home_agh():
    if not monitor.get_agh()["enabled"]:
        return None
    st = monitor.get_agh_stats_latest() or {}
    try:
        top = monitor.get_agh_top(3)
    except Exception:
        top = {"blocked": []}
    return {"queries": st.get("num_dns_queries"), "blocked": st.get("num_blocked_filtering"),
            "blocked_pct": st.get("blocked_pct"), "avg_ms": round((st.get("avg_processing_time") or 0) * 1000, 1),
            "top_blocked": top.get("blocked", [])[:3], "ts": st.get("ts")}


@app.get("/api/home")
def home_ep():
    """Tudo o que a página inicial mostra além dos cards, numa chamada (cada parte falha sozinha)."""
    def safe(fn):
        try:
            return fn()
        except Exception as e:
            print(f"[home] {fn.__name__}: {e}", flush=True)
            return None
    now = time.time()
    slow = safe(_home_slow) or {}
    sp = db.query("SELECT ts, download, upload, latency FROM speedtests ORDER BY ts DESC LIMIT 1")
    last_out = db.query("SELECT target, started_ts, resolved_ts FROM incidents WHERE type IN ('offline','local') "
                        "ORDER BY started_ts DESC LIMIT 1")
    active_out = [k for k in monitor._active_incidents if k[0] in _OUTAGE_TYPES]
    if active_out:
        quiet = {"since": None, "target": active_out[0][1], "now": True}
    elif last_out:
        quiet = {"since": last_out[0]["resolved_ts"], "target": last_out[0]["target"], "now": False}
    else:
        first = db.query("SELECT MIN(ts) m FROM pings")
        quiet = {"since": first[0]["m"] if first else None, "target": None, "now": False}
    ip_since = db.get_meta("public_ip_since")
    cam = None
    try:
        c = dvr.get_cfg()
        if c["enabled"] and c["host"]:
            cam = {"channels": [{"ch": ch, "name": dvr.channel_name(c, ch)} for ch in range(1, c["channels"] + 1)]}
    except Exception:
        pass
    return {
        "ts": now,
        "kpi": {**{k: slow.get(k) for k in ("up_today", "up_7d", "up_30d", "month_incidents", "month_mttr_s")},
                "public_ip": db.get_meta("public_ip"), "public_ip_since": float(ip_since) if ip_since else None,
                "speedtest": sp[0] if sp else None, "speedtest_auto": monitor.get_speedtest_auto(), "quiet": quiet},
        "heat": slow.get("heat"),
        "avail": safe(_home_avail),
        "net": safe(_home_network),
        "agh": safe(_home_agh),
        "dns": safe(dns_status),
        "system": safe(system_ep),
        "cams": cam,
    }


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


@app.get("/api/topomap")
def topomap_ep():
    """Mapa em caixas: destinos agrupados (grupo definido no destino ou automático), ligações entre
    grupos seguindo o "Depende de", estado de cada item e caixas extras (ambiente, câmeras)."""
    th = monitor.THRESH
    targets = monitor.get_targets()
    names = {t["name"] for t in targets}
    snap = monitor.window_snapshot()
    active = monitor._active_incidents
    parent = {t["name"]: (t.get("parent") if t.get("parent") in names else None) for t in targets}
    has_kids = {p for p in parent.values() if p}

    raw = {}
    for t in targets:
        n, sn = t["name"], snap.get(t["name"])
        if ("offline", n) in active or (sn and not sn["online"] and sn["loss_pct"] >= 50):
            raw[n] = "bad"
        elif not sn:
            raw[n] = "na"
        elif sn["loss_pct"] >= th.get("loss_pct", 2) or (sn["latency"] or 0) > th.get("ping_ms", 80) or \
                any((k, n) in active for k in ("loss", "latency", "jitter")):
            raw[n] = "warn"
        else:
            raw[n] = "ok"

    def state(n, seen=()):
        st = raw[n]
        p = parent.get(n)
        if st == "bad" and p and p not in seen and state(p, seen + (n,)) in ("bad", "iso"):
            return "iso"                    # caiu porque o pai caiu
        return st

    def gname(t):
        if t.get("group"):
            return t["group"]
        if not _is_private_host(t["host"]):
            return "Internet"
        return t["name"] if t["name"] in has_kids else "Rede local"

    groups, order = {}, []
    for t in targets:
        g = gname(t)
        if g not in groups:
            groups[g] = {"id": g, "label": g, "items": [], "auto": not t.get("group")}
            order.append(g)
        sn = snap.get(t["name"]) or {}
        groups[g]["items"].append({"name": t["name"], "host": t["host"], "state": state(t["name"]),
                                   "latency": sn.get("latency"), "loss": sn.get("loss_pct")})
    gof = {t["name"]: gname(t) for t in targets}
    edges = {}
    for t in targets:
        p = parent.get(t["name"])
        a = gof[p] if p else "__origin"
        b = gof[t["name"]]
        if a != b:
            edges.setdefault((a, b), []).append(t["name"])
    # grupo sem ligação de entrada (ex.: só itens com pai no mesmo grupo) sai da origem
    incoming = {b for (_, b) in edges}
    for g in order:
        if g not in incoming:
            edges.setdefault(("__origin", g), [])
    rank = {"bad": 4, "iso": 3, "warn": 2, "na": 1, "ok": 0}
    for g in groups.values():
        sts = [i["state"] for i in g["items"]]
        g["state"] = ("na" if not sts or all(x == "na" for x in sts) else "bad" if "bad" in sts else
                      "iso" if all(x == "iso" for x in sts) else "warn" if any(x in ("warn", "iso") for x in sts) else "ok")
        g["all_down"] = bool(sts) and all(x in ("bad", "iso") for x in sts)
        g["kind"] = ("internet" if g["id"] == "Internet" else
                     "device" if len(g["items"]) == 1 and g["items"][0]["name"] == g["id"] else "group")
    out_edges = []
    for (a, b), via in edges.items():
        g = groups[b]
        st = "bad" if g["all_down"] else ("warn" if g["state"] in ("bad", "iso", "warn") else "ok" if g["state"] == "ok" else "na")
        if all(x["state"] == "iso" for x in g["items"]) and g["items"]:
            st = "iso"
        lats = [i["latency"] for i in g["items"] if i["latency"] is not None and i["state"] != "bad"]
        out_edges.append({"from": a, "to": b, "state": st, "latency": round(sum(lats) / len(lats), 1) if lats else None})

    # extras
    sysm = {r["key"]: r["value"] for r in db.query("SELECT key,value FROM meta WHERE key IN ('cpu_pct','temp_c','mem_pct')")}
    env = [{"name": f"{monitor.HOST_LABEL} · CPU", "value": sysm.get("cpu_pct"), "unit": "%", "warn": 70, "bad": 90},
           {"name": f"{monitor.HOST_LABEL} · temp.", "value": sysm.get("temp_c"), "unit": " °C", "warn": 65, "bad": 75},
           {"name": f"{monitor.HOST_LABEL} · memória", "value": sysm.get("mem_pct"), "unit": "%", "warn": 80, "bad": 92}]
    mt = monitor.get_mikrotik_status() if monitor.get_mikrotik()["enabled"] else None
    if mt:
        env += [{"name": "MikroTik · CPU", "value": mt.get("cpu_load"), "unit": "%", "warn": 70, "bad": 90},
                {"name": "MikroTik · temp.", "value": mt.get("temperature"), "unit": " °C", "warn": 65, "bad": 80}]
    for e in env:
        try:
            v = float(e["value"]) if e["value"] not in (None, "") else None
        except (TypeError, ValueError):
            v = None
        e["value"] = round(v, 1) if v is not None else None
        e["state"] = "na" if v is None else "bad" if v >= e["bad"] else "warn" if v >= e["warn"] else "ok"
    env = [e for e in env if e["value"] is not None]
    cams = None
    try:
        c = dvr.get_cfg()
        if c["enabled"] and c["host"]:
            host_t = next((t["name"] for t in targets if str(t["host"]) == c["host"]), None)
            attach = gof.get(host_t) if host_t else next((g for g in order if g != "Internet"), "__origin")
            cams = {"attach": attach or "__origin", "items": [
                {"name": dvr.channel_name(c, ch), "ch": ch,
                 "state": "bad" if ("camera", dvr.channel_name(c, ch)) in active else "ok"} for ch in range(1, c["channels"] + 1)]}
    except Exception:
        pass
    cnt = {k: 0 for k in rank}
    for g in groups.values():
        for i in g["items"]:
            cnt[i["state"]] += 1
    return {"origin": {"id": "__origin", "label": monitor.HOST_LABEL, "app": monitor.get_app_name()},
            "groups": [groups[g] for g in order], "edges": out_edges, "env": env, "cams": cams,
            "summary": {"total": len(targets), **cnt, "incidents": len(active)}}


class SpeedAutoIn(BaseModel):
    enabled: bool
    time: str = "04:30"


@app.get("/api/settings/speedtest")
def speed_auto_get():
    return monitor.get_speedtest_auto()


@app.post("/api/settings/speedtest")
def speed_auto_set(item: SpeedAutoIn, request: Request):
    try:
        monitor.set_speedtest_auto(item.enabled, item.time)
    except ValueError as e:
        raise HTTPException(400, str(e))
    audit(request, "speedtest-auto", f"{item.enabled} {item.time}")
    return {"ok": True}


@app.get("/api/health/workers")
def workers_ep():
    return monitor.worker_health()


@app.get("/api/system")
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


@app.get("/status")
def status_page():
    return FileResponse("static/status.html")


@app.get("/api/public/status")
def public_status():
    p = _public_payload()
    if p is None:
        raise HTTPException(404, "Página de status desativada")
    return p



app.mount("/", StaticFiles(directory="static", html=True), name="static")
