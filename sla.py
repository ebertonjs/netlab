"""SLA: disponibilidade, MTTR/MTBF por alvo, exportação CSV."""
import csv, io, time, datetime
import db
import stats
import monitor


def period_bounds(month=None, days=30):
    """month='YYYY-MM' ou últimos N dias. Retorna (start, end)."""
    if month:
        y, m = [int(x) for x in month.split("-")]
        start = datetime.datetime(y, m, 1)
        end = datetime.datetime(y + (m == 12), (m % 12) + 1, 1)
        return start.timestamp(), min(end.timestamp(), time.time())
    end = time.time()
    return end - days * 86400, end


def report(start, end, targets=None):
    names = targets or [t["name"] for t in monitor.get_targets()]
    span = max(1.0, end - start)
    sql, params = stats._union(start, 3600, names)
    agg = {}
    for r in db.query(sql, params):
        a = agg.setdefault(r["target"], [0, 0, 0.0, 0.0, 0.0])
        a[0] += r["n"] or 0
        a[1] += r["ok"] or 0
        a[2] += r["lat_sum"] or 0
        a[3] = max(a[3], r["lat_max"] or 0)
        a[4] += r["jit_sum"] or 0
    inc = db.query("SELECT target, started_ts, resolved_ts FROM incidents WHERE type='offline' "
                   "AND started_ts < ? AND COALESCE(resolved_ts, ?) > ? ORDER BY started_ts", (end, end, start))
    by = {}
    for i in inc:
        s = max(i["started_ts"], start)
        e = min(i["resolved_ts"] or end, end)
        by.setdefault(i["target"], []).append((s, e, i["resolved_ts"] is not None))
    out = []
    for n in names:
        a = agg.get(n)
        incs = by.get(n, [])
        down = sum(e - s for s, e, _ in incs)
        resolved = [(s, e) for s, e, r in incs if r]
        mttr = sum(e - s for s, e in resolved) / len(resolved) if resolved else None
        up_time = max(0.0, span - down)
        mtbf = up_time / len(incs) if incs else None
        out.append({
            "target": n,
            "availability_pct": round(100 * a[1] / a[0], 3) if a and a[0] else None,
            "samples": a[0] if a else 0,
            "avg_latency_ms": round(a[2] / a[1], 2) if a and a[1] else None,
            "max_latency_ms": round(a[3], 2) if a else None,
            "avg_jitter_ms": round(a[4] / a[0], 2) if a and a[0] else None,
            "outages": len(incs),
            "downtime_s": round(down),
            "mttr_s": round(mttr) if mttr is not None else None,
            "mtbf_s": round(mtbf) if mtbf is not None else None,
        })
    return {"start": start, "end": end, "targets": out}


def _safe(v):
    """Evita injeção de fórmula no Excel/LibreOffice (valor começando com = + - @)."""
    if isinstance(v, str) and v[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + v
    return v


def to_csv(rep, app="NetNOC"):
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";")
    f = lambda ts: datetime.datetime.fromtimestamp(ts).strftime("%d/%m/%Y %H:%M")
    w.writerow([f"Relatório SLA {_safe(app)}", f(rep["start"]), f(rep["end"])])
    w.writerow(["Alvo", "Disponibilidade %", "Amostras", "Latência média ms", "Latência máx ms",
                "Jitter médio ms", "Quedas", "Tempo fora (s)", "MTTR (s)", "MTBF (s)"])
    for t in rep["targets"]:
        row = [t["target"], t["availability_pct"], t["samples"], t["avg_latency_ms"], t["max_latency_ms"],
               t["avg_jitter_ms"], t["outages"], t["downtime_s"], t["mttr_s"], t["mtbf_s"]]
        w.writerow([_safe("" if v is None else (str(v).replace(".", ",") if isinstance(v, float) else v))
                    for v in row])
    return "﻿" + buf.getvalue()
