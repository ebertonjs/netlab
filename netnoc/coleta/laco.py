"""Laço supervisionado: cada coletor roda numa thread que nunca morre por exceção; saúde dos coletores.

Parte do antigo monitor.py (v4.4); o monitor.py continua reexportando tudo."""
import time, threading




# --------------------------------------------------------------- laço supervisionado
_health = {}          # nome -> {last_run, last_ok, error, runs, interval}
_hlock = threading.Lock()


def _sleep_until(t0, get_iv):
    """Dorme em fatias de 1 s relendo o intervalo: mudança na config vale na hora
    (antes: com intervalo de 12 h, a nova configuração só valia depois de 12 h)."""
    while True:
        try:
            iv = max(1, float(get_iv()))
        except Exception:
            iv = 60
        rem = t0 + iv - time.time()
        if rem <= 0:
            return
        time.sleep(min(rem, 1.0))


def _loop(name, once, get_iv, first_delay=0):
    """Executa `once` para sempre. Exceção nunca mata a thread (antes: um 'database locked'
    derrubava o worker em silêncio e o painel mostrava o último valor como se estivesse vivo)."""
    time.sleep(first_delay)
    while True:
        t0 = time.time()
        err = None
        try:
            once()
        except Exception as e:
            err = _safe_err(e)
            print(f"[{name}] {err}", flush=True)
        with _hlock:
            h = _health.setdefault(name, {"runs": 0, "errors": 0})
            h["runs"] += 1
            h["last_run"] = time.time()
            if err:
                h["errors"] += 1
                h["error"] = err
                h["error_ts"] = time.time()
            else:
                h["last_ok"] = time.time()
                h["error"] = None
            try:
                h["interval"] = float(get_iv())
            except Exception:
                pass
        _sleep_until(t0, get_iv)


def worker_health():
    now = time.time()
    out = []
    with _hlock:
        items = {k: dict(v) for k, v in _health.items()}
    for name, h in sorted(items.items()):
        iv = h.get("interval") or 60
        last = h.get("last_run")
        stalled = last is None or now - last > iv * 3 + 120
        out.append({"name": name, "interval": iv, "last_run": last, "last_ok": h.get("last_ok"),
                    "runs": h.get("runs", 0), "errors": h.get("errors", 0), "error": h.get("error"),
                    "status": "stalled" if stalled else ("error" if h.get("error") else "ok")})
    try:
        out += external_health()
    except Exception:
        pass
    # v4.0: coletor sem nada configurado fica fora da lista (e nunca vira aviso de "coleta com falha")
    idle = _idle_workers()
    return [w for w in out if w["name"] not in idle]


def _idle_workers():
    idle = set()
    try:
        if not get_mikrotik().get("enabled"):
            idle.add("mikrotik")
        if not get_agh().get("enabled"):
            idle.add("adguard")
        if not any(t.get("type") == "http" and str(t.get("host", "")).startswith("https://") for t in get_targets()):
            idle.add("certificados")
        from netnoc.integracoes import dvr
        if not dvr.get_cfg().get("enabled"):
            idle |= {"go2rtc", "cameras_foto"}
    except Exception:
        pass
    return idle


# dependências entre os módulos da coleta: no fim do arquivo porque há ciclos
# (ex.: incidentes avisa pelo Telegram, que consulta os destinos); só são usadas na hora da chamada
from netnoc.coleta.adguard import get_agh  # noqa: E402
from netnoc.coleta.alvos import get_targets  # noqa: E402
from netnoc.coleta.mikrotik import _safe_err, get_mikrotik  # noqa: E402
from netnoc.coleta.ping import external_health  # noqa: E402
