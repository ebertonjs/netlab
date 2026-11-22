"""Página inicial, a rede contada, diagnóstico sob demanda, diário, mapa da rede e máquina do tempo."""
import time
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from netnoc.analise import diagnose, story, timemachine
from netnoc.coleta import monitor
from netnoc.integracoes import dvr
from netnoc.nucleo import db, stats
from netnoc.web.comum import _is_private_host, audit
from netnoc.web.rotas.metricas import dns_status
from netnoc.web.rotas.sistema import system_ep

router = APIRouter()


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


class DiagIn(BaseModel):
    target: Optional[str] = None


@router.post("/api/diagnose")
def diagnose_ep(data: DiagIn, request: Request):
    """Investiga agora (rede toda ou um destino). Mesmo motor do diagnóstico automático."""
    names = []
    if data.target:
        if data.target not in {t["name"] for t in monitor.get_targets()}:
            raise HTTPException(404, "Destino não encontrado")
        names = [data.target]
    if not diagnose._lock.acquire(timeout=60):
        raise HTTPException(429, "Já existe um diagnóstico em andamento")
    try:
        d = diagnose.investigate("check", names)
    finally:
        diagnose._lock.release()
    audit(request, "diagnose", data.target or "rede")
    return d


@router.post("/api/diary/test")
def diary_test_ep():
    return {"text": story.diary(24)}


@router.get("/api/home")
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
    def _story():
        return story.story(48)
    return {
        "ts": now,
        "story": safe(_story),
        "kpi": {**{k: slow.get(k) for k in ("up_today", "up_7d", "up_30d", "month_incidents", "month_mttr_s")},
                "public_ip": db.get_meta("public_ip"), "public_ip_since": float(ip_since) if ip_since else None,
                "wan_peak": safe(lambda: monitor.wan_peak(86400)), "quiet": quiet},
        "heat": slow.get("heat"),
        "avail": safe(_home_avail),
        "net": safe(_home_network),
        "agh": safe(_home_agh),
        "dns": safe(dns_status),
        "system": safe(system_ep),
        "cams": cam,
    }


@router.get("/api/topomap")
def topomap_ep(at: Optional[float] = None):
    """Mapa em caixas: destinos agrupados (grupo definido no destino ou automático), ligações entre
    grupos seguindo o "Depende de", estado de cada item e caixas extras (ambiente, câmeras).
    Com ?at=<timestamp>: o mapa como estava naquele momento (máquina do tempo)."""
    if at is not None and at < time.time() - 5:
        snap, active = timemachine.snapshot_at(at), timemachine.active_at(at)
        out = _topomap(snap, active, history=True)
        incs = timemachine.incidents_at(at)
        diags = {}
        for d in diagnose.recent(max(1, (time.time() - at) / 3600 + 24), 300):
            for i in d["incident_ids"]:
                diags[i] = d["title"]
        out["at"] = at
        out["incidents"] = [{"target": i["target"], "message": i["message"], "severity": i["severity"],
                             "started_ts": i["started_ts"], "cause": diags.get(i["id"])} for i in incs]
        return out
    return _topomap(monitor.window_snapshot(), monitor._active_incidents)


@router.get("/api/timemachine")
def timemachine_ep(hours: int = 24):
    """Faixa disponível e os episódios (para marcar na régua do tempo)."""
    first, last = timemachine.bounds()
    hours = max(1, min(hours, 24 * 30))
    eps = story.episodes(hours)
    return {"first": first, "now": last, "from": max(first, last - hours * 3600),
            "marks": [{"start": e["start"], "end": e["end"], "level": e["level"], "title": e["title"], "cause": e["cause"]} for e in eps]}


def _topomap(snap, active, history=False):
    th = monitor.THRESH
    targets = monitor.get_targets()
    names = {t["name"] for t in targets}
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

    # extras (no passado não há medição de ambiente por item: a caixa some)
    sysm = {} if history else {r["key"]: r["value"] for r in db.query("SELECT key,value FROM meta WHERE key IN ('cpu_pct','temp_c','mem_pct')")}
    env = [{"name": f"{monitor.HOST_LABEL} · CPU", "value": sysm.get("cpu_pct"), "unit": "%", "warn": 70, "bad": 90},
           {"name": f"{monitor.HOST_LABEL} · temp.", "value": sysm.get("temp_c"), "unit": " °C", "warn": 65, "bad": 75},
           {"name": f"{monitor.HOST_LABEL} · memória", "value": sysm.get("mem_pct"), "unit": "%", "warn": 80, "bad": 92}]
    mt = monitor.get_mikrotik_status() if monitor.get_mikrotik()["enabled"] and not history else None
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
