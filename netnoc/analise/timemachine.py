"""Máquina do tempo: o estado da rede em qualquer momento do passado.

snapshot_at(ts) devolve o mesmo formato do monitor.window_snapshot() (online, latência, perda…),
calculado a partir dos pings gravados: nos últimos dias usa as amostras brutas (mesma janela de
avaliação do monitor); antes disso, os agregados de 5 minutos. active_at(ts) devolve os incidentes
que estavam abertos naquele instante. O mapa da rede usa os dois para se redesenhar no passado.
"""
import time

from netnoc.nucleo import db
from netnoc.coleta import monitor


def bounds():
    """Primeiro e último instante com dados."""
    a = db.query("SELECT MIN(ts) m FROM pings")
    b = db.query("SELECT MIN(bucket) m FROM pings_5m")
    first = min([x for x in ((a[0]["m"] if a else None), (b[0]["m"] if b else None)) if x] or [time.time()])
    return first, time.time()


def snapshot_at(at):
    at = float(at)
    win = monitor.WINDOW_S
    rows = db.query("SELECT target, ts, latency, success, jitter FROM pings WHERE ts > ? AND ts <= ? ORDER BY target, ts",
                    (at - win, at))
    by = {}
    for r in rows:
        by.setdefault(r["target"], []).append(r)
    out = {}
    for name, rs in by.items():
        ok = [r for r in rs if r["success"]]
        last = rs[-1]
        out[name] = {"online": bool(last["success"]), "latency": last["latency"] if last["success"] else None,
                     "avg_latency": sum(r["latency"] or 0 for r in ok) / len(ok) if ok else None,
                     "avg_jitter": sum(r["jitter"] or 0 for r in rs) / len(rs), "jitter": last["jitter"] or 0,
                     "loss_pct": 100 * (1 - len(ok) / len(rs)), "last_ts": last["ts"], "samples": len(rs)}
    # sem bruto (mais antigo que a retenção): agregados de 5 min
    missing = [t["name"] for t in monitor.get_targets() if t["name"] not in out]
    if missing:
        b = int(at // 300) * 300
        q = ",".join("?" * len(missing))
        for r in db.query(f"SELECT target, n, ok, lat_sum, jit_sum FROM pings_5m WHERE bucket IN (?, ?) AND target IN ({q}) "
                          "ORDER BY bucket DESC", [b, b - 300] + missing):
            if r["target"] in out or not r["n"]:
                continue
            okn = r["ok"] or 0
            lat = (r["lat_sum"] / okn) if okn else None
            out[r["target"]] = {"online": okn / r["n"] >= 0.5, "latency": lat, "avg_latency": lat,
                                "avg_jitter": (r["jit_sum"] or 0) / r["n"], "jitter": (r["jit_sum"] or 0) / r["n"],
                                "loss_pct": 100 * (1 - okn / r["n"]), "last_ts": b, "samples": r["n"]}
    return out


def incidents_at(at):
    return db.query("SELECT * FROM incidents WHERE started_ts <= ? AND (resolved_ts IS NULL OR resolved_ts > ?) "
                    "AND severity != 'Info' ORDER BY started_ts", (at, at))


def active_at(at):
    return {(i["type"], i["target"]): {"id": i["id"], "severity": i["severity"], "started_ts": i["started_ts"]}
            for i in incidents_at(at)}
