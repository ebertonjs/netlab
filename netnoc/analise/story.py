"""A rede contada, não desenhada: linha do tempo narrativa (página inicial) e diário diário (Telegram).

story(): uma frase de cabeçalho ("Tudo estável há 3 dias" / "Agora: Google fora há 4 min — operadora"),
o resumo das últimas 24 h e os episódios recentes, cada um com a causa encontrada pelo diagnóstico.
diary(): o mesmo período contado em texto para o Telegram, enviado todo dia no horário escolhido.
"""
import json, threading, time
from collections import defaultdict
from datetime import datetime

from netnoc.nucleo import db
from netnoc.analise import diagnose
from netnoc.coleta import monitor
from netnoc.nucleo import stats

BAD_TYPES = ("offline", "local")
WARN_TYPES = ("loss", "latency", "jitter", "dns", "cert", "agent", "snmp", "snmpval", "camera", "dvr_hd", "cpu", "temp")
dur, _n = diagnose.dur, diagnose._n


def _hm(ts):
    return datetime.fromtimestamp(ts).strftime("%H:%M")


def _when(ts):
    d = datetime.fromtimestamp(ts)
    today = datetime.now().date()
    if d.date() == today:
        return "hoje " + d.strftime("%H:%M")
    if (today - d.date()).days == 1:
        return "ontem " + d.strftime("%H:%M")
    return d.strftime("%d/%m %H:%M")


def episodes(hours=48, limit=200):
    """Incidentes agrupados pelo diagnóstico que os explicou (+ períodos com o servidor desligado)."""
    now = time.time()
    since = now - hours * 3600
    incs = db.query("SELECT * FROM incidents WHERE (started_ts >= ? OR resolved_ts IS NULL OR resolved_ts >= ?) "
                    "AND severity != 'Info' ORDER BY started_ts DESC LIMIT ?", (since, since, limit))
    by_id = {i["id"]: i for i in incs}
    diags = diagnose.recent(hours + 2, 200)
    used, eps = set(), []
    for d in diags:
        if d["kind"] == "gap":
            eps.append({"start": d["ts"], "end": d["end_ts"], "open": False, "level": "bad" if d["cause"] == "power" else "info",
                        "kind": "gap", "targets": [], "title": d["title"], "cause": None, "cause_code": d["cause"],
                        "text": d["text"], "diag_id": d["id"]})
            continue
        mine = [by_id[i] for i in d["incident_ids"] if i in by_id and i not in used]
        if not mine:
            continue
        used.update(i["id"] for i in mine)
        open_ = any(i["resolved_ts"] is None for i in mine)
        start = min(i["started_ts"] for i in mine)
        end = None if open_ else max(i["resolved_ts"] for i in mine)
        lvl = "bad" if any(i["type"] in BAD_TYPES for i in mine) else "warn"
        tg = list(dict.fromkeys(i["target"] for i in mine))
        eps.append({"start": start, "end": end, "open": open_, "level": lvl, "kind": mine[0]["type"], "targets": tg,
                    "title": _title(mine), "cause": d["title"], "cause_code": d["cause"], "text": d["text"],
                    "confidence": d["confidence"], "tips": d["tips"], "evidence": d["evidence"], "diag_id": d["id"]})
    for i in incs:
        if i["id"] in used:
            continue
        eps.append({"start": i["started_ts"], "end": i["resolved_ts"], "open": i["resolved_ts"] is None,
                    "level": "bad" if i["type"] in BAD_TYPES else "warn", "kind": i["type"], "targets": [i["target"]],
                    "title": i["message"], "cause": None, "cause_code": None, "text": "", "diag_id": None})
    eps = [e for e in eps if e["open"] or (e["end"] or e["start"]) >= since]
    eps.sort(key=lambda e: e["start"], reverse=True)
    for e in eps:
        e["duration_s"] = (e["end"] or now) - e["start"]
        # recém-aberto e ainda sem causa: o diagnóstico automático está rodando
        e["pending"] = bool(not e["cause"] and e["kind"] in diagnose.DIAG_TYPES and now - e["start"] < 120)
    return eps


def _title(incs):
    t = incs[0]
    names = list(dict.fromkeys(i["target"] for i in incs))
    if t["type"] == "local":
        return "Nenhum destino respondia"
    if t["type"] == "offline":
        return (names[0] + " fora do ar") if len(names) == 1 else f"{len(names)} destinos fora do ar ({', '.join(names[:3])}{'…' if len(names) > 3 else ''})"
    return t["message"]


def _uptime_avg(secs):
    up = stats.uptime_pct(secs) or {}
    names = {t["name"] for t in monitor.get_targets() if t.get("type") != "agent"}
    vals = [v for k, v in up.items() if k in names and v is not None]
    return (sum(vals) / len(vals) if vals else None), {k: v for k, v in up.items() if k in names}


SHORT = {"isp": "operadora", "isp_link": "operadora", "isp_quality": "operadora", "local": "falha local", "power": "energia",
         "stopped": "NetNOC parado", "router_reboot": "reinício do roteador", "device": "aparelho", "parent": "equipamento",
         "lan_partial": "rede local", "lan_quality": "rede local", "remote": "serviço externo", "remote_quality": "serviço externo",
         "remote_dns": "DNS", "dns_local": "DNS", "dns_upstream": "DNS", "dns_server": "DNS", "saturation": "banda saturada",
         "recovered": "queda curta"}


def _cause_totals(eps):
    tot = defaultdict(float)
    for e in eps:
        if e["level"] == "bad":
            tot[SHORT.get(e.get("cause_code"), "sem diagnóstico")] += e["duration_s"]
    return sorted(tot.items(), key=lambda x: -x[1])


def story(hours=48):
    now = time.time()
    eps = episodes(hours)
    open_bad = [e for e in eps if e["open"] and e["level"] == "bad"]
    open_warn = [e for e in eps if e["open"] and e["level"] == "warn"]
    if open_bad:
        e = open_bad[0]
        state = "bad"
        head = f"Agora: {e['title']} há {dur(e['duration_s'])}"
        sub = ("Causa provável: " + e["cause"]) if e["cause"] else "Investigando a causa…"
    elif open_warn:
        e = open_warn[0]
        state = "warn"
        head = f"Atenção: {e['title'].rstrip('.')} há {dur(e['duration_s'])}"
        sub = ("Causa provável: " + e["cause"]) if e["cause"] else "A rede funciona, mas com qualidade reduzida."
    else:
        state = "ok"
        last = db.query("SELECT resolved_ts, target, type FROM incidents WHERE type IN ('offline','local') AND resolved_ts IS NOT NULL "
                        "ORDER BY resolved_ts DESC LIMIT 1")
        gap = db.query("SELECT end_ts FROM diagnoses WHERE kind='gap' AND cause='power' ORDER BY end_ts DESC LIMIT 1")
        ref = max([r for r in ((last[0]["resolved_ts"] if last else None), (gap[0]["end_ts"] if gap else None)) if r] or [0])
        if ref:
            head = f"Tudo estável há {dur(now - ref)}"
            le = next((e for e in eps if e["level"] == "bad" and not e["open"]), None)
            sub = (f"Última queda: {_when(le['start'])} · {le['title']}" + (f" — {le['cause']}" if le["cause"] else "") +
                   f" ({dur(le['duration_s'])})") if le else "Nenhuma queda nas últimas 48 h."
        else:
            first = db.query("SELECT MIN(ts) m FROM pings")
            f0 = first[0]["m"] if first and first[0]["m"] else None
            head = f"Tudo estável há {dur(now - f0)}" if f0 else "Começando a monitorar"
            sub = "Nenhuma queda desde o início do monitoramento." if f0 else "Os primeiros dados aparecem em alguns segundos."
    # resumo das últimas 24 h
    e24 = [e for e in eps if (e["end"] or now) >= now - 86400]
    up24, _ = _uptime_avg(86400)
    bad24 = [e for e in e24 if e["level"] == "bad"]
    parts = []
    if up24 is not None:
        parts.append(f"{_n(up24, 2 if up24 < 99.995 else 0)}% disponível")
    parts.append(f"{len(bad24)} queda{'s' if len(bad24) != 1 else ''}" if bad24 else "nenhuma queda")
    tot = _cause_totals(bad24)
    if tot:
        parts.append("fora do ar por " + ", ".join(f"{c} {dur(s)}" for c, s in tot[:3]))
    warn24 = [e for e in e24 if e["level"] == "warn"]
    if warn24:
        parts.append(f"{len(warn24)} alerta{'s' if len(warn24) != 1 else ''} de qualidade")
    try:
        pats = [p["message"] for p in monitor.detect_patterns(30)[:2]]
    except Exception:
        pats = []
    return {"state": state, "headline": head, "sub": sub, "day": "Últimas 24 h: " + " · ".join(parts),
            "episodes": eps[:15], "total": len(eps), "insights": pats, "ts": now}


# ------------------------------------------------------------------ diário (Telegram)
def diary(hours=24):
    now = time.time()
    eps = [e for e in episodes(hours) if (e["end"] or now) >= now - hours * 3600]
    up, per = _uptime_avg(hours * 3600)
    bad = [e for e in eps if e["level"] == "bad"]
    warn = [e for e in eps if e["level"] == "warn"]
    L = [f"📔 Diário da rede · {datetime.fromtimestamp(now - hours * 3600).strftime('%d/%m %H:%M')} → {datetime.fromtimestamp(now).strftime('%d/%m %H:%M')}"]
    if not bad and not warn:
        L.append("Período tranquilo: nenhuma queda e nenhum alerta. ✅")
    else:
        resumo = []
        if bad:
            tot = sum(e["duration_s"] for e in bad)
            causas = ", ".join(f"{c} {dur(t)}" for c, t in _cause_totals(bad)[:3])
            resumo.append(f"{len(bad)} queda{'s' if len(bad) > 1 else ''} ({dur(tot)} fora do ar: {causas})")
        if warn:
            resumo.append(f"{len(warn)} alerta{'s' if len(warn) > 1 else ''} de qualidade")
        L.append("Resumo: " + " e ".join(resumo) + ".")
    if up is not None:
        L.append(f"Disponibilidade média: {_n(up, 2)}%")
    worst = sorted([(v, k) for k, v in per.items() if v is not None and v < 99.99])[:4]
    if worst:
        L.append("Abaixo de 100%: " + ", ".join(f"{k} {_n(v, 2)}%" for v, k in worst))
    if bad:
        L += ["", "Quedas:"]
        for e in sorted(bad, key=lambda x: x["start"])[:10]:
            fim = _hm(e["end"]) if e["end"] else "agora"
            L.append(f"• {_hm(e['start'])}–{fim} {e['title']} ({dur(e['duration_s'])})" + (f" → {e['cause']}" if e["cause"] else ""))
    if warn:
        L += ["", "Qualidade:"]
        for e in sorted(warn, key=lambda x: x["start"])[:6]:
            L.append(f"• {_hm(e['start'])} {e['title'].rstrip('.')} ({dur(e['duration_s'])})" + (f" → {e['cause']}" if e["cause"] else ""))
    # pior latência do período
    try:
        ser = stats.series(hours * 3600)
        pk = max(((r["latency"], n, r["ts"]) for n, rows in ser.items() for r in rows if r.get("latency") is not None), default=None)
        if pk and pk[0] > monitor.THRESH["ping_ms"]:
            L += ["", f"Pior latência: {pk[1]} com {_n(pk[0])} ms às {_hm(pk[2])}"]
    except Exception:
        pass
    sp = db.query("SELECT ts, download, upload FROM speedtests WHERE ts >= ? ORDER BY ts DESC LIMIT 1", (now - hours * 3600,))
    if sp and sp[0]["download"] is not None:
        L.append(f"Speedtest ({_hm(sp[0]['ts'])}): ↓ {_n(sp[0]['download'], 0)} ↑ {_n(sp[0]['upload'] or 0, 0)} Mbps")
    try:
        pats = monitor.detect_patterns(30)[:2]
        if pats:
            L += ["", "Padrões dos últimos 30 dias:"] + ["• " + p["message"] for p in pats]
    except Exception:
        pass
    return "\n".join(L)


def _diary_loop():
    from netnoc.bot import aibot
    while True:
        time.sleep(30)
        try:
            cfg = aibot.get_cfg()
            if not cfg.get("diary"):
                continue
            now = datetime.now()
            hh, mm = (int(x) for x in str(cfg.get("diary_time") or "07:00").split(":"))
            if (now.hour, now.minute) < (hh, mm):
                continue
            today = now.strftime("%Y-%m-%d")
            if db.get_meta("diary_last") == today:
                continue
            if (now.hour * 60 + now.minute) - (hh * 60 + mm) > 180:      # NetNOC estava desligado na hora: não manda atrasado demais
                db.set_meta("diary_last", today)
                continue
            tg = monitor.get_telegram()
            if tg.get("bot_token") and tg.get("chat_id"):
                aibot._send(tg["bot_token"], tg["chat_id"], diary(24))
            db.set_meta("diary_last", today)
        except Exception as e:
            print(f"[diario] {type(e).__name__}: {e}", flush=True)


_started = False


def start():
    global _started
    if not _started:
        _started = True
        threading.Thread(target=_diary_loop, daemon=True, name="diario").start()
