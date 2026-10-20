"""Multi-site: agentes remotos enviam pings 'alvo@site'; aqui ingerimos e comparamos as visões."""
import json, time
import db
import monitor
import security

TOKEN_KEY = "agent_token_hash"
_last_seen = {}


def new_token():
    t = security.new_token()
    db.set_setting(TOKEN_KEY, security.token_hash(t))
    return t


def check_auth(header):
    if not header or not header.startswith("Bearer "):
        return False
    return security.check_token(TOKEN_KEY, header[7:])


def agent_config(site):
    """Alvos que o agente do site deve sondar: os que listam o site em 'sites'."""
    out = []
    for t in monitor.get_targets():
        if site in (t.get("sites") or []) and t.get("type", "icmp") in ("icmp", "tcp"):
            out.append({"name": t["name"], "host": t["host"], "type": t.get("type", "icmp"),
                        "port": t.get("port"), "interval": t.get("interval")})
    return {"site": site, "interval": monitor.get_intervals()["ping_interval_seconds"], "targets": out}


def ingest(site, rows):
    """rows: [{target, ts, latency}] — valida tudo; devolve quantidade aceita."""
    if not security.valid_name(site, 40) or "@" in site:
        raise ValueError("Site inválido")
    allowed = {t["name"] for t in monitor.get_targets() if site in (t.get("sites") or [])}
    now = time.time()
    batch = []
    prev = {}
    for r in rows[:500]:
        name = r.get("target")
        if name not in allowed:
            continue
        ts = float(r.get("ts") or now)
        if abs(ts - now) > 600:
            continue
        lat = r.get("latency")
        lat = float(lat) if lat is not None else None
        if lat is not None and not (0 <= lat < 1e5):
            continue
        key = f"{name}@{site}"
        p = prev.get(key)
        jit = abs(lat - p) if (lat is not None and p is not None) else 0
        if lat is not None:
            prev[key] = lat
        batch.append((key, ts, lat, int(lat is not None), jit))
    db.insert_pings(batch)
    # amostras atrasadas (buffer do agente) que caem num bucket já agregado: reagrega o trecho,
    # senão somem do histórico quando o bruto é apagado
    if batch:
        try:
            end5 = float(db.get_meta("rollup5_end") or 0)
            oldest = min(b[1] for b in batch)
            if end5 and oldest < end5:
                start = int(oldest // 300) * 300
                db.rollup_chunk("pings", "pings_5m", 300, start, end5)
        except Exception:
            pass
    _last_seen[site] = now
    db.set_meta(f"agent_seen:{site}", now)
    return len(batch)


def view(window=300):
    """Por alvo: estado local x estado em cada site, e um diagnóstico."""
    since = time.time() - window
    rows = db.query("SELECT target, COUNT(*) n, SUM(success) ok FROM pings WHERE ts>=? AND target LIKE '%@%' "
                    "GROUP BY target", (since,))
    remote = {}
    for r in rows:
        name, site = r["target"].rsplit("@", 1)
        remote.setdefault(name, {})[site] = {"up": bool(r["ok"]), "loss_pct": round(100 * (1 - r["ok"] / r["n"]), 1)}
    snap = monitor.window_snapshot()
    out = []
    for t in monitor.get_targets():
        n = t["name"]
        sites = remote.get(n, {})
        if not sites:
            continue
        local = snap.get(n, {}).get("online")
        remote_up = [s["up"] for s in sites.values()]
        if local is False and not any(remote_up):
            diag = "Alvo fora para todos os sites — problema no alvo"
        elif local is False and any(remote_up):
            diag = "Só o servidor central perde o alvo — problema na conexão do central"
        elif local and not all(remote_up):
            diag = "Alvo ok localmente, mas inacessível de algum site — problema no caminho do site"
        else:
            diag = "Ok"
        out.append({"target": n, "local": local, "sites": sites, "diagnosis": diag})
    return out


def sites_status():
    seen = {}
    for r in db.query("SELECT key, value FROM meta WHERE key LIKE 'agent_seen:%'"):
        seen[r["key"].split(":", 1)[1]] = float(r["value"])
    return [{"site": s, "last_seen": ts, "online": time.time() - ts < 180} for s, ts in sorted(seen.items())]


def watchdog():
    """Incidente se um agente que já reportou ficar mudo por mais de 3 min."""
    for s in sites_status():
        key = f"agent:{s['site']}"
        monitor._hyst("agent", s["site"], not s["online"],
                      lambda s=s: monitor.raise_incident("agent", s["site"],
                                                         f"Agente do site {s['site']} sem comunicação", "Media"),
                      n_open=1, n_close=1)
