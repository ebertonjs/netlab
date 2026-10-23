"""Agregações: rollups (5 min / 1 h) e consultas unificadas sobre raw + 5m + 1h."""
import time, threading
import db

_ttl = {}
_tlock = threading.Lock()


def ttl_cache(seconds):
    def deco(fn):
        def wrapper(*a):
            k = (fn.__name__, a)
            now = time.time()
            with _tlock:
                hit = _ttl.get(k)
                if hit and hit[0] > now:
                    return hit[1]
            val = fn(*a)
            with _tlock:
                if len(_ttl) > 500:
                    _ttl.clear()
                _ttl[k] = (now + seconds, val)
            return val
        wrapper.__name__ = fn.__name__
        return wrapper
    return deco


def cache_clear():
    with _tlock:
        _ttl.clear()


# ------------------------------------------------------------------ rollups
CHUNK = 6 * 3600


def _meta_f(key):
    v = db.get_meta(key)
    try:
        return float(v) if v is not None else None
    except ValueError:
        return None


def run_rollups(now=None):
    """Idempotente e incremental; o backfill é feito em blocos para não travar o escritor."""
    now = now or time.time()
    end5 = int(now // 300) * 300
    cur = _meta_f("rollup5_end")
    if cur is None:
        r = db.query_w("SELECT MIN(ts) m FROM pings")
        cur = (int(r[0]["m"] // 300) * 300) if r and r[0]["m"] else end5
    # reprocessa o último bucket parcial por segurança (REPLACE)
    start = cur
    while start < end5:
        stop = min(start + CHUNK, end5)
        db.rollup_chunk("pings", "pings_5m", 300, start, stop)
        db.set_meta("rollup5_end", stop)
        start = stop
    end1 = int(now // 3600) * 3600
    cur1 = _meta_f("rollup1_end")
    if cur1 is None:
        r = db.query_w("SELECT MIN(bucket) m FROM pings_5m")
        cur1 = (int(r[0]["m"] // 3600) * 3600) if r and r[0]["m"] else end1
    start = cur1
    while start < end1:
        stop = min(start + 24 * 3600, end1)
        db.rollup_chunk("pings_5m", "pings_1h", 3600, start, stop)
        db.set_meta("rollup1_end", stop)
        start = stop
    cache_clear()


@ttl_cache(30)
def _rollup5_end():
    return _meta_f("rollup5_end")


def _meta_f_cached():
    return _rollup5_end()


@ttl_cache(300)
def _min5():
    r = db.query("SELECT MIN(bucket) m FROM pings_5m")
    m = r[0]["m"] if r and r[0]["m"] is not None else None
    return m


def rollup5_min():
    return _min5()


# --------------------------------------------------------------- consulta unificada
def _union(since, B, targets=None, raw_days=7):
    """SQL + params com colunas (target, b, n, ok, lat_sum, lat_max, jit_sum) em buckets de B s."""
    now = time.time()
    # bruto só na última hora (o resto vem do rollup de 5 min). Antes: 7 dias de bruto em
    # toda consulta > 1 h (SLA 30d, página pública...) -> milhões de linhas com ping de 10 s.
    r5 = _meta_f_cached()
    b5 = int((now - 3600) // 300) * 300
    if r5 is None or r5 < b5:
        # rollup atrasado/inexistente: cai para o bruto onde ainda há bruto
        b5 = int((now - raw_days * 86400) // 300) * 300 if r5 is None else max(int(r5), int((now - raw_days * 86400) // 300) * 300)
    m5 = rollup5_min()
    m5h = (int(-(-m5 // 3600)) * 3600) if m5 is not None else None   # 1h só antes disso
    tf = ""
    tp = []
    if targets:
        tf = " AND target IN (%s)" % ",".join("?" * len(targets))
        tp = list(targets)
    parts, params = [], []
    # raw
    raw_from = max(since, b5)
    parts.append(f"""SELECT target, CAST(ts/{B} AS INTEGER)*{B} b, COUNT(*) n, SUM(success) ok,
        COALESCE(SUM(latency),0) lat_sum, COALESCE(MAX(latency),0) lat_max, COALESCE(SUM(jitter),0) jit_sum
        FROM pings WHERE ts>=?{tf} GROUP BY target, b""")
    params += [raw_from] + tp
    if since < b5:
        lo5 = max(since, m5h) if m5h is not None else since
        parts.append(f"""SELECT target, CAST(bucket/{B} AS INTEGER)*{B} b, SUM(n), SUM(ok),
            SUM(lat_sum), MAX(lat_max), SUM(jit_sum)
            FROM pings_5m WHERE bucket>=? AND bucket<?{tf} GROUP BY target, b""")
        params += [lo5, b5] + tp
        if m5h is not None and since < m5h:
            parts.append(f"""SELECT target, CAST(bucket/{B} AS INTEGER)*{B} b, SUM(n), SUM(ok),
                SUM(lat_sum), MAX(lat_max), SUM(jit_sum)
                FROM pings_1h WHERE bucket>=? AND bucket<?{tf} GROUP BY target, b""")
            params += [since, m5h] + tp
    sql = ("SELECT target, b, SUM(n) n, SUM(ok) ok, SUM(lat_sum) lat_sum, MAX(lat_max) lat_max, SUM(jit_sum) jit_sum FROM ("
           + " UNION ALL ".join(parts) + ") GROUP BY target, b ORDER BY target, b")
    return sql, params


def bucket_for(seconds):
    if seconds <= 3600:
        return 0            # sem agregação (bruto)
    if seconds <= 86400:
        return 300
    if seconds <= 7 * 86400:
        return 1800
    return 3600


def series(seconds, targets=None):
    """{target: [{ts, latency, jitter, loss_pct, up_pct}]}. Até 1h usa bruto (≤ ~720 pts/alvo)."""
    since = time.time() - seconds
    B = bucket_for(seconds)
    out = {}
    if B == 0:
        tf, tp = "", []
        if targets:
            tf = " AND target IN (%s)" % ",".join("?" * len(targets))
            tp = list(targets)
        step = max(1, int(seconds // 600))
        rows = db.query(
            f"SELECT target, CAST(ts/{step} AS INTEGER)*{step} b, COUNT(*) n, SUM(success) ok, "
            f"SUM(latency) ls, MAX(latency) lm, SUM(jitter) js FROM pings WHERE ts>=?{tf} GROUP BY target, b ORDER BY target, b",
            [since] + tp)
        for r in rows:
            ok = r["ok"] or 0
            out.setdefault(r["target"], []).append({
                "ts": r["b"], "latency": (r["ls"] / ok) if ok else None,
                "jitter": (r["js"] / r["n"]) if r["n"] else 0,
                "loss_pct": 100 * (1 - ok / r["n"]), "max": r["lm"] if ok else None})
        return out
    sql, params = _union(since, B, targets)
    for r in db.query(sql, params):
        ok = r["ok"] or 0
        n = r["n"] or 0
        if not n:
            continue
        out.setdefault(r["target"], []).append({
            "ts": r["b"], "latency": (r["lat_sum"] / ok) if ok else None,
            "jitter": r["jit_sum"] / n, "loss_pct": 100 * (1 - ok / n),
            "max": r["lat_max"] if ok else None})
    return out


def uptime_pct(seconds, targets=None):
    """{target: pct} de disponibilidade na janela."""
    since = time.time() - seconds
    sql, params = _union(since, 3600 if seconds > 86400 else 300, targets)
    acc = {}
    for r in db.query(sql, params):
        a = acc.setdefault(r["target"], [0, 0])
        a[0] += r["n"] or 0
        a[1] += r["ok"] or 0
    return {t: (round(100 * ok / n, 3) if n else None) for t, (n, ok) in acc.items()}


def hourly_bars(hours=24, targets=None):
    """Uma única query para todos os alvos (antes: 24 queries por alvo)."""
    now = time.time()
    end = int(now // 3600) * 3600 + 3600
    since = end - hours * 3600
    sql, params = _union(since, 3600, targets)
    res = {}
    for r in db.query(sql, params):
        res.setdefault(r["target"], {})[r["b"]] = (r["n"], r["ok"])
    out = {}
    for t, m in res.items():
        bars = []
        for i in range(hours):
            b = since + i * 3600
            n_ok = m.get(b)
            bars.append({"ts": b + 3600,
                         "pct": round(100 * n_ok[1] / n_ok[0], 1) if n_ok and n_ok[0] else None})
        out[t] = bars
    return out


@ttl_cache(30)
def availability_blocks(hours=24, block=1800):
    """{target: [(ts_inicio, n, ok, lat_media|None) x N]} em blocos fixos (padrão 30 min) até agora."""
    now = time.time()
    end = int(now // block) * block + block
    since = end - hours * 3600
    sql, params = _union(since, block)
    res = {}
    for r in db.query(sql, params):
        res.setdefault(r["target"], {})[r["b"]] = (r["n"] or 0, r["ok"] or 0, r["lat_sum"] or 0)
    out = {}
    nb = hours * 3600 // block
    for t, m in res.items():
        row = []
        for i in range(nb):
            b = since + i * block
            n, ok, ls = m.get(b, (0, 0, 0))
            row.append((b, n, ok, round(ls / ok, 1) if ok else None))
        out[t] = row
    return out


def sparklines(seconds=3600, points=30):
    """Mini-série de latência por alvo para a tabela."""
    s = series(seconds)
    out = {}
    for t, rows in s.items():
        vals = [r["latency"] for r in rows]
        if len(vals) > points:
            step = len(vals) / points
            vals = [vals[int(i * step)] for i in range(points)]
        out[t] = vals
    return out


def heatmap(target, days=14):
    """Matriz dia×hora (hora local) de latência média e perda para um alvo."""
    import datetime
    days = max(1, min(int(days), 90))
    now = time.time()
    since = (int(now // 86400) - days) * 86400
    sql, params = _union(since, 3600, [target])
    cells = {}
    for r in db.query(sql, params):
        dt = datetime.datetime.fromtimestamp(r["b"])
        key = (dt.date().isoformat(), dt.hour)
        c = cells.setdefault(key, [0, 0, 0.0])
        c[0] += r["n"] or 0
        c[1] += r["ok"] or 0
        c[2] += r["lat_sum"] or 0
    today = datetime.date.today()
    day_list = [(today - datetime.timedelta(days=i)).isoformat() for i in range(days - 1, -1, -1)]
    out = []
    for di, d in enumerate(day_list):
        for h in range(24):
            c = cells.get((d, h))
            if c and c[0]:
                out.append({"d": di, "h": h, "lat": round(c[2] / c[1], 1) if c[1] else None,
                            "loss": round(100 * (1 - c[1] / c[0]), 1)})
    return {"target": target, "days": day_list, "cells": out}


@ttl_cache(60)
def daily_bars(days=30, targets=None):
    """Disponibilidade diária (para a página pública)."""
    import datetime
    now = time.time()
    since = (int(now // 86400) - days) * 86400
    tl = list(targets) if targets else None
    sql, params = _union(since, 3600, tl)
    acc = {}
    for r in db.query(sql, params):
        d = datetime.datetime.fromtimestamp(r["b"]).date().isoformat()
        a = acc.setdefault(r["target"], {}).setdefault(d, [0, 0])
        a[0] += r["n"] or 0
        a[1] += r["ok"] or 0
    today = datetime.date.today()
    day_list = [(today - datetime.timedelta(days=i)).isoformat() for i in range(days - 1, -1, -1)]
    out = {}
    for t, m in acc.items():
        out[t] = [{"date": d, "pct": round(100 * m[d][1] / m[d][0], 2) if d in m and m[d][0] else None}
                  for d in day_list]
    return out
