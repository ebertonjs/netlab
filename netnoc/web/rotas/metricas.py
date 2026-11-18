"""Leitura de métricas: visão geral, histórico de latência/perda, destinos, DNS, incidentes, eventos, SLA, tempo real (SSE)."""
import asyncio, json, time
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response, StreamingResponse

from netnoc.analise import sla
from netnoc.coleta import monitor
from netnoc.nucleo import db, stats
from netnoc.web.comum import RANGE_SECONDS, secs

router = APIRouter()


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


@router.get("/api/overview")
def overview():
    if time.time() - _ov[0] > 2 or _ov[1] is None:
        _ov[1] = build_overview()
        _ov[0] = time.time()
    return _ov[1]


@router.get("/api/ping/history")
def ping_history(range: str = "5m"):
    s = stats.series(secs(range))
    return {t["name"]: [{"ts": r["ts"], "latency": r["latency"], "jitter": r["jitter"],
                         "loss_pct": r["loss_pct"]} for r in s.get(t["name"], [])]
            for t in monitor.get_targets()}


@router.get("/api/loss/history")
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


@router.get("/api/targets")
def targets():
    return _targets_payload()


@router.get("/api/uptime/bars")
def uptime_bars(hours: int = 24):
    hours = max(1, min(hours, 168))
    bars = stats.hourly_bars(hours)
    return {t["name"]: bars.get(t["name"], []) for t in monitor.get_targets()}


@router.get("/api/sparklines")
def sparklines():
    return stats.sparklines()


@router.get("/api/insights/patterns")
def insights_patterns(days: int = 30):
    return monitor.detect_patterns(max(1, min(days, 365)))


@router.get("/api/dns")
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


@router.get("/api/dns/history")
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


@router.get("/api/incidents")
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


@router.get("/api/events")
def events(limit: int = 50):
    return db.query("SELECT * FROM events ORDER BY ts DESC LIMIT ?", (max(1, min(limit, 500)),))


@router.get("/api/incidents/summary")
def incidents_summary(days: int = 7):
    rows = db.query("SELECT severity, COUNT(*) c FROM incidents WHERE started_ts >= ? GROUP BY severity",
                    (time.time() - days * 86400,))
    counts = {"Alta": 0, "Media": 0, "Baixa": 0, "Info": 0}
    for r in rows:
        counts[r["severity"]] = counts.get(r["severity"], 0) + r["c"]
    return counts


@router.get("/api/speedtest/history")
def speedtest_history(limit: int = 30):
    return db.query("SELECT * FROM speedtests ORDER BY ts DESC LIMIT ?", (max(1, min(limit, 500)),))


@router.get("/api/history/24h")
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


@router.get("/api/topology")
def topology():
    return monitor.build_topology()


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


@router.get("/api/snapshot")
def snapshot():
    return build_snapshot()


@router.get("/api/stream")
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


# --------------------------------------------------------------------- SLA
def _sla_range(month, days):
    try:
        return sla.period_bounds(month, max(1, min(days, 365)))
    except (ValueError, IndexError):
        raise HTTPException(400, "Mês inválido (use AAAA-MM)")


@router.get("/api/sla")
def sla_ep(month: Optional[str] = None, days: int = 30):
    s, e = _sla_range(month, days)
    return sla.report(s, e)


@router.get("/api/sla.csv")
def sla_csv(request: Request, month: Optional[str] = None, days: int = 30):
    s, e = _sla_range(month, days)
    body = sla.to_csv(sla.report(s, e), monitor.get_app_name())
    return Response(body.encode("utf-8"), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": 'attachment; filename="sla-netnoc.csv"'})



# ============================================================== bloco 3
@router.get("/api/heatmap")
def heatmap_ep(target: str, days: int = 14):
    if target not in {t["name"] for t in monitor.get_targets()}:
        raise HTTPException(404, "Alvo não encontrado")
    return stats.heatmap(target, days)
