#!/usr/bin/env python3
"""Agente NetNOC para sites remotos. Requer apenas Python 3 + requests.

Uso:  python3 agent.py --url https://noc.exemplo:8000 --site filial-a --token XXXX [--insecure]
O servidor decide quais alvos sondar (alvos com este site em 'sites'). Envia 'alvo@site' ao central.
"""
import argparse, re, socket, subprocess, sys, time
import requests


def ping(host, timeout=1):
    if not re.match(r"^[A-Za-z0-9._:\-]+$", host) or host.startswith("-"):
        return None
    try:
        out = subprocess.run(["ping", "-c", "1", "-W", str(timeout), host], capture_output=True, text=True,
                             timeout=timeout + 2)
        m = re.search(r"time[=<]([\d.]+)", out.stdout)
        return float(m.group(1)) if out.returncode == 0 and m else None
    except Exception:
        return None


def tcp(host, port, timeout=2):
    t0 = time.time()
    try:
        socket.create_connection((host, int(port)), timeout=timeout).close()
        return (time.time() - t0) * 1000
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--site", required=True)
    ap.add_argument("--token", required=True)
    ap.add_argument("--insecure", action="store_true", help="não validar o certificado do servidor")
    a = ap.parse_args()
    s = requests.Session()
    s.headers["Authorization"] = "Bearer " + a.token
    s.verify = not a.insecure
    base = a.url.rstrip("/")
    cfg, cfg_at = None, 0
    buf = []
    while True:
        t0 = time.time()
        try:
            if cfg is None or t0 - cfg_at > 300:
                r = s.get(f"{base}/api/agent/config", params={"site": a.site}, timeout=10)
                r.raise_for_status()
                cfg, cfg_at = r.json(), t0
        except Exception as e:
            print("config:", e, file=sys.stderr)
        for t in (cfg or {}).get("targets", []):
            lat = tcp(t["host"], t.get("port") or 80) if t.get("type") == "tcp" else ping(t["host"])
            buf.append({"target": t["name"], "ts": time.time(), "latency": lat})
        if buf:
            try:
                r = s.post(f"{base}/api/agent/report", json={"site": a.site, "rows": buf[-500:]}, timeout=10)
                r.raise_for_status()
                buf = []
            except Exception as e:
                print("report:", e, file=sys.stderr)
                buf = buf[-500:]
        time.sleep(max(1, (cfg or {}).get("interval", 5) - (time.time() - t0)))


if __name__ == "__main__":
    main()
