"""Medir agora (v4.3): a velocidade real da internet lida no MikroTik a cada segundo.

O Pi 3 tem placa de 100 Mbps, então um speedtest feito nele mede o Pi. E a coleta normal (a cada
15 a 60 s) faz média: um speedtest de 10 s a 900 Mbps vira ~150 Mbps no gráfico. Aqui o NetNOC pede
ao MikroTik a taxa da porta WAN uma vez por segundo durante 30 a 120 s, enquanto você roda o
speedtest no celular ou no PC. O pico aparece como ele é. Não precisa do device-mode (só leitura).

Fonte da taxa: `/interface/monitor-traffic once` (o próprio RouterOS calcula bits/s). Se o RouterOS
recusar, cai para a diferença dos contadores de bytes de `/interface` entre duas leituras.
"""
import json, threading, time
from urllib.parse import quote

from netnoc.coleta import monitor
from netnoc.nucleo import db, tlspin

MIN_S, MAX_S, DEFAULT_S = 15, 120, 45
_lock = threading.Lock()
_cur = {}            # sessão em andamento (ou a última)
_HIST_KEY = "medicoes"


class MedirError(RuntimeError):
    pass


def _cfg():
    cfg = monitor.get_mikrotik()
    if not cfg.get("enabled") or not cfg.get("host") or not cfg.get("username"):
        raise MedirError("integração MikroTik desativada")
    return cfg


def _req(cfg, method, path, body=None):
    r = tlspin.request(cfg, method, f"{monitor._mikrotik_base_url(cfg)}/{path}", auth=(cfg["username"], cfg["password"]),
                       json=body, timeout=4)
    if not r.ok:
        raise MedirError(f"MikroTik HTTP {r.status_code}")
    return r.json()


def _rate_monitor(cfg, iface):
    """(rx_bps, tx_bps) calculados pelo RouterOS."""
    j = _req(cfg, "POST", "interface/monitor-traffic", {"interface": iface, "once": ""})
    row = j[0] if isinstance(j, list) and j else j
    return float(row["rx-bits-per-second"]), float(row["tx-bits-per-second"])


def _counters(cfg, iface):
    j = _req(cfg, "GET", f"interface?name={quote(iface, safe='')}")
    if not j:
        raise MedirError(f"porta {iface} não encontrada no MikroTik")
    return int(j[0]["rx-byte"]), int(j[0]["tx-byte"])


def _pick_iface():
    name = monitor.wan_iface()
    if not name:
        raise MedirError("não sei qual é a porta da internet: escolha em Configurações → Integrações → MikroTik")
    return name


def start(seconds=DEFAULT_S, who="painel", on_done=None):
    """Começa uma medição em segundo plano. Devolve o estado inicial. Uma por vez."""
    seconds = max(MIN_S, min(MAX_S, int(seconds or DEFAULT_S)))
    with _lock:
        if _cur.get("running"):
            raise MedirError("já há uma medição em andamento")
        cfg = _cfg()
        iface = _pick_iface()
        _cur.clear()
        _cur.update(running=True, iface=iface, started=time.time(), seconds=seconds, who=who,
                    samples=[], method=None, error=None)
    threading.Thread(target=_run, args=(cfg, iface, seconds, on_done), daemon=True, name="medir").start()
    return state()


def _run(cfg, iface, seconds, on_done):
    t_end = time.time() + seconds
    method, prev, fails = "monitor", None, 0
    try:
        while time.time() < t_end:
            t0 = time.time()
            try:
                if method == "monitor":
                    try:
                        rx, tx = _rate_monitor(cfg, iface)
                    except (MedirError, KeyError, ValueError, TypeError):
                        if _cur["samples"]:
                            raise
                        method = "contadores"          # RouterOS sem monitor-traffic pela REST: usa os contadores
                        continue
                    _cur["samples"].append((round(t0, 2), rx, tx))
                else:
                    rb, tb = _counters(cfg, iface)
                    t = time.time()
                    if prev and t > prev[0] and rb >= prev[1] and tb >= prev[2]:
                        dt = t - prev[0]
                        _cur["samples"].append((round(t, 2), (rb - prev[1]) * 8 / dt, (tb - prev[2]) * 8 / dt))
                    prev = (t, rb, tb)
                _cur["method"] = method
                fails = 0
            except Exception as e:
                fails += 1
                if fails >= 5:
                    raise MedirError(f"o MikroTik parou de responder ({monitor._safe_err(e)})")
            time.sleep(max(0.0, 1.0 - (time.time() - t0)))
    except Exception as e:
        _cur["error"] = str(e)[:160]
    finally:
        _cur["running"] = False
        _cur["ended"] = time.time()
        res = result()
        if res:
            _save(res)
        if on_done:
            try:
                on_done(res, _cur.get("error"))
            except Exception as e:
                print(f"[medir] aviso: {type(e).__name__}", flush=True)


def _top(vals, n=3):
    """Média dos n maiores segundos: um pico isolado de 1 s não vira a 'velocidade'."""
    v = sorted(vals, reverse=True)[:n]
    return sum(v) / len(v) if v else 0.0


def result():
    s = _cur.get("samples") or []
    if not s:
        return None
    rx = [x[1] for x in s]
    tx = [x[2] for x in s]
    return {"ts": _cur["started"], "iface": _cur["iface"], "seconds": round((s[-1][0] - s[0][0]) if len(s) > 1 else 1),
            "n": len(s), "method": _cur.get("method"), "who": _cur.get("who"),
            "rx_peak": max(rx), "tx_peak": max(tx), "rx_top3": _top(rx), "tx_top3": _top(tx)}


def state():
    s = _cur.get("samples") or []
    out = {k: _cur.get(k) for k in ("running", "iface", "started", "seconds", "method", "error", "who")}
    out["samples"] = s[-MAX_S:]
    out["now"] = time.time()
    out["result"] = result()
    return out


def _save(res):
    h = history()
    h.insert(0, res)
    db.set_meta(_HIST_KEY, json.dumps(h[:20]))


def history():
    try:
        return json.loads(db.get_meta(_HIST_KEY) or "[]")
    except ValueError:
        return []


def mbps(bps):
    return f"{bps / 1e6:.0f}" if bps >= 1e7 else f"{bps / 1e6:.1f}"


def format_text(res, err=None, plan_mbps=None):
    if not res:
        return f"⚠️ Medição sem dados: {err or 'o MikroTik não respondeu'}"
    lines = [f"📶 Medição da internet ({res['iface']}, {res['seconds']} s)",
             f"⬇️ Download: pico {mbps(res['rx_peak'])} Mbps · média dos 3 melhores segundos {mbps(res['rx_top3'])} Mbps",
             f"⬆️ Upload: pico {mbps(res['tx_peak'])} Mbps · média dos 3 melhores segundos {mbps(res['tx_top3'])} Mbps"]
    if plan_mbps:
        lines.append(f"Plano: {plan_mbps} Mbps → download chegou a {res['rx_top3'] / 1e6 / plan_mbps * 100:.0f}% do contratado")
    if res["rx_top3"] < 5e7:
        lines.append("Dica: rode o speedtest durante a medição; sem tráfego o número fica baixo.")
    if err:
        lines.append(f"(parou antes do fim: {err})")
    return "\n".join(lines)
