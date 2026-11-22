"""Ping/TCP/HTTP dos destinos, janela de avaliação, saúde dos destinos e leitura do coletor Rust.

Parte do antigo monitor.py (v4.4); o monitor.py continua reexportando tudo."""
import subprocess, time, json, re, os
from collections import deque
from concurrent.futures import ThreadPoolExecutor, wait as futures_wait


from netnoc.nucleo import db
from netnoc.nucleo import security
from netnoc.coleta.base import HOST_LABEL, IS_WINDOWS, LOCAL_LABEL, LOSS_MIN_FAILS, MIN_SAMPLES, OFFLINE_N, RECOVER_N, THRESH, WINDOW, WINDOW_S, _active_incidents, _clean_since, _consec, _inflight, _last_latency, _next_due, _pending, _started_at, _state_lock, _win

# ------------------------------------------------------------------------ ping
_ingest_last_id = None    # último id de pings já lido (coletor externo)

def ping_host(host, timeout=1):
    """Latência em ms ou None."""
    if not security.valid_host(host):
        return None
    count_flag = "-n" if IS_WINDOWS else "-c"
    timeout_flag = "-w" if IS_WINDOWS else "-W"
    timeout_val = str(int(timeout * 1000)) if IS_WINDOWS else str(timeout)
    try:
        out = subprocess.run(["ping", count_flag, "1", timeout_flag, timeout_val, host],
                             capture_output=True, text=True, timeout=timeout + 2)
        if out.returncode != 0:
            return None
        m = re.search(r"time[=<]([\d.]+)", out.stdout)
        return float(m.group(1)) if m else None
    except Exception:
        return None


def probe_target(t):
    """Despacha pelo tipo de check (icmp por padrão). Retorna latência ms ou None."""
    ttype = t.get("type", "icmp")
    if ttype != "icmp":
        try:
            from netnoc.coleta import checks
            return checks.probe(t)
        except ImportError:
            return None
    return ping_host(t["host"])


def _record_result(name, ts, lat, jitter=None):
    """Atualiza a janela em memória. `jitter` vem pronto quando a amostra foi lida do banco (coletor externo)."""
    ok = lat is not None
    with _state_lock:
        prev = _last_latency.get(name)
        if jitter is None:
            jitter = abs(lat - prev) if (ok and prev is not None) else 0
        if ok:
            _last_latency[name] = lat
        _win.setdefault(name, deque(maxlen=WINDOW)).append((ts, lat, ok, jitter))
        c = _consec.setdefault(name, [0, 0])
        if ok:
            c[0], c[1] = 0, c[1] + 1
        else:
            c[0], c[1] = c[0] + 1, 0
    return (name, ts, lat, int(ok), jitter)


def _recent(rows, now=None, since=None):
    """Amostras dentro da janela de tempo (mínimo MIN_SAMPLES), opcionalmente após `since`."""
    now = now or time.time()
    lo = now - WINDOW_S
    out = [r for r in rows if r[0] >= lo]
    if len(out) < MIN_SAMPLES:
        out = rows[-MIN_SAMPLES:]
    if since:
        cut = [r for r in out if r[0] >= since]
        out = cut if cut else out[-1:]
    return out


def window_snapshot():
    out = {}
    now = time.time()
    with _state_lock:
        items = {k: list(v) for k, v in _win.items()}
    for name, rows in items.items():
        if not rows:
            continue
        rows = _recent(rows, now)
        ok = [r for r in rows if r[2]]
        out[name] = {
            "online": bool(rows[-1][2]), "latency": rows[-1][1],
            "avg_latency": sum(r[1] for r in ok) / len(ok) if ok else None,
            "avg_jitter": sum(r[3] for r in rows) / len(rows),
            "jitter": rows[-1][3],
            "loss_pct": 100 * (1 - len(ok) / len(rows)),
            "last_ts": rows[-1][0], "samples": len(rows)}
    return out


def warm_state():
    """Preenche as janelas deslizantes a partir do banco ao iniciar."""
    global _ingest_last_id
    _ingest_last_id = (db.query_w("SELECT MAX(id) m FROM pings") or [{"m": 0}])[0]["m"] or 0
    for t in get_targets():
        rows = db.query_w("SELECT ts, latency, success, jitter FROM pings WHERE target=? AND ts>=? "
                          "ORDER BY ts DESC LIMIT ?", (t["name"], time.time() - max(WINDOW_S, 3600), WINDOW))
        d = deque(maxlen=WINDOW)
        for r in reversed(rows):
            d.append((r["ts"], r["latency"], bool(r["success"]), r["jitter"] or 0))
            if r["success"]:
                _last_latency[t["name"]] = r["latency"]
        if d:
            _win[t["name"]] = d
            fails = 0
            for r in rows:
                if r["success"]:
                    break
                fails += 1
            _consec[t["name"]] = [fails, 0 if fails else 1]


def _parent_down(name, items):
    for anc in _ancestors(name, items):
        if ("offline", anc) in _active_incidents:
            return anc
    return None


def _mark_clean(name):
    """Depois de uma recuperação, as falhas antigas não podem abrir 'perda'/'jitter' em seguida."""
    with _state_lock:
        _clean_since[name] = time.time()
        for k in ("loss", "jitter", "latency"):
            _pending.pop((k, name), None)


def evaluate_target_health(name, items=None):
    with _state_lock:
        rows = list(_win.get(name, ()))
        fails_c, oks_c = _consec.get(name, [0, 0])
        since = _clean_since.get(name)
    if not rows:
        return
    rows = _recent(rows, since=since)
    total = len(rows)
    fails = sum(1 for r in rows if not r[2])
    loss_pct = fails / total * 100
    lats = [r[1] for r in rows if r[2]]
    avg_lat = sum(lats) / len(lats) if lats else None
    avg_jit = sum(r[3] for r in rows) / total

    items = items if items is not None else get_targets()
    # offline: N falhas consecutivas abrem; M sucessos consecutivos fecham
    key = ("offline", name)
    if fails_c >= OFFLINE_N and key not in _active_incidents:
        anc = _parent_down(name, items)
        if anc:
            if ("suppressed", name) not in _pending:
                _pending[("suppressed", name)] = True
                log_event(f"{name} sem resposta — causa provável: {anc} offline (alerta suprimido)", "Info")
        else:
            raise_incident("offline", name, f"{name} está offline", "Alta")
    elif oks_c >= RECOVER_N:
        was_down = key in _active_incidents or _pending.pop(("suppressed", name), None)
        if key in _active_incidents:
            resolve_incident("offline", name)
        if was_down:
            _mark_clean(name)
            return

    offline = key in _active_incidents or fails_c >= OFFLINE_N
    if offline:
        return      # latência/jitter/perda são ruído enquanto está fora
    if fails_c > 0:
        return      # sequência de falhas em curso: espera confirmar offline ou recuperar
    if avg_lat is not None:
        _hyst("latency", name, avg_lat > THRESH["ping_ms"],
              lambda: raise_incident("latency", name, f"Alta latência detectada no destino {name}", "Alta"))
    _hyst("jitter", name, avg_jit > THRESH["jitter_ms"],
          lambda: raise_incident("jitter", name, f"Jitter alto detectado em {name}", "Media"))
    _hyst("loss", name, loss_pct > THRESH["loss_pct"] and fails >= LOSS_MIN_FAILS,
          lambda: raise_incident("loss", name, f"Perda de pacotes detectada para {name}", "Media"))


def _check_local_outage(local_names):
    """Todos os destinos locais sem resposta ao mesmo tempo = problema no próprio NetNOC/link.
    Abre UM incidente em vez de N alertas 'offline'. Retorna True se a queda local está ativa."""
    key = ("local", LOCAL_LABEL)
    with _state_lock:
        st = [_consec.get(n) for n in local_names if n in _consec]
    if len(st) < 3:
        if key in _active_incidents:
            resolve_incident("local", LOCAL_LABEL, "Conectividade restabelecida")
        return False
    all_failing = all(c[0] > 0 for c in st)
    confirmed = sum(1 for c in st if c[0] >= OFFLINE_N) >= max(2, (len(st) + 1) // 2)
    if all_failing and confirmed:
        if key not in _active_incidents:
            raise_incident("local", LOCAL_LABEL,
                           "Nenhum destino responde — provável falha local (link, switch, gateway ou o próprio "
                           f"{HOST_LABEL}). Alertas individuais suprimidos.", "Alta")
        return True
    if key in _active_incidents and not all_failing:
        resolve_incident("local", LOCAL_LABEL, "Conectividade restabelecida")
        for n in local_names:
            with _state_lock:
                c = _consec.get(n, [0, 0])
            if c[0] == 0:
                _mark_clean(n)
    return key in _active_incidents


_pool = ThreadPoolExecutor(max_workers=16, thread_name_prefix="probe")


def ping_cycle(force=False):
    """Um ciclo: dispara as sondas vencidas e coleta as que terminaram.
    Uma sonda lenta (HTTP com timeout) não segura mais o ciclo dos ICMP: fica em voo e é coletada depois."""
    now = time.time()
    interval = get_intervals()["ping_interval_seconds"]
    items = get_targets()
    names = {t["name"] for t in items}
    for t in items:
        n = t["name"]
        if n in _inflight:
            continue
        iv = max(1, int(t.get("interval") or interval))
        if force or _next_due.get(n, 0) <= now:
            _next_due[n] = now + iv
            _inflight[n] = (t, time.time(), _pool.submit(probe_target, t))
    if not _inflight:
        return 0
    futures_wait([v[2] for v in _inflight.values()], timeout=2.5)
    rows, done = [], []
    for n, (t, ts, f) in list(_inflight.items()):
        if not f.done():
            if time.time() - ts > 60:          # sonda travada: conta como falha
                _inflight.pop(n, None)
                if n in names:
                    rows.append(_record_result(n, ts, None))
                    done.append(n)
            continue
        _inflight.pop(n, None)
        if n not in names:
            continue
        try:
            lat = f.result()
        except Exception:
            lat = None
        rows.append(_record_result(n, ts, lat))
        done.append(n)
    db.insert_pings(rows)
    _evaluate_done(done, items)
    return len(rows)


def _evaluate_done(done, items):
    if not done:
        return
    local = [t["name"] for t in items]
    if _check_local_outage(local):
        return
    for n in dict.fromkeys(done):
        evaluate_target_health(n, items)


# ------------------------------------------------- coletor externo (netnoc-collector, Rust)
# NETNOC_EXTERNAL_COLLECTOR=ping,mikrotik,agh  -> esses módulos são coletados pelo binário Rust.
# Sem a variável, tudo roda aqui como antes. Se o coletor parar (heartbeat com mais de
# EXTERNAL_STALE_S), o Python volta a coletar sozinho até ele reaparecer.
EXTERNAL = {m.strip().lower() for m in os.environ.get("NETNOC_EXTERNAL_COLLECTOR", "").split(",")
            if m.strip().lower() in ("ping", "mikrotik", "agh")}
EXTERNAL_STALE_S = int(os.environ.get("NETNOC_EXTERNAL_STALE", "60"))
_ext_cache = {"t": 0.0, "alive": False, "info": {}}
_ext_mode = {}            # módulo -> True (externo) / False (interno): para logar as trocas


def _external_alive():
    now = time.time()
    if now - _ext_cache["t"] < 3:
        return _ext_cache["alive"]
    alive, info = False, {}
    try:
        r = db.query_w("SELECT value, ts FROM meta WHERE key='collector:heartbeat'")
        if r:
            info = json.loads(r[0]["value"] or "{}")
            alive = not info.get("stopped") and now - float(r[0]["ts"] or 0) < EXTERNAL_STALE_S
    except Exception:
        pass
    # recém-iniciado: dá tempo ao coletor de subir antes de assumir que ele não existe
    if not alive and now - _started_at < EXTERNAL_STALE_S and not info.get("stopped"):
        alive = True
    _ext_cache.update(t=now, alive=alive, info=info)
    return alive


def external_active(mod):
    """True se `mod` está entregue ao coletor externo e ele está vivo."""
    if mod not in EXTERNAL:
        return False
    on = _external_alive()
    if _ext_mode.get(mod) != on:
        if mod in _ext_mode:          # não loga a primeira decisão, só as trocas
            log_event(f"Coletor externo ({mod}): " + ("assumiu a coleta" if on else
                      "sem sinal — coleta voltou para o NetNOC"), "Info" if on else "Media")
        _ext_mode[mod] = on
    return on


def ingest_pings():
    """Lê as amostras gravadas pelo coletor externo e passa pela mesma avaliação do ciclo interno
    (janela em memória, offline/perda/latência/jitter, queda local). Não grava nada em pings."""
    global _ingest_last_id
    if _ingest_last_id is None:
        _ingest_last_id = (db.query_w("SELECT MAX(id) m FROM pings") or [{"m": 0}])[0]["m"] or 0
        return 0
    rows = db.query_w("SELECT id, target, ts, latency, success, jitter FROM pings WHERE id>? ORDER BY id LIMIT 5000",
                      (_ingest_last_id,))
    if not rows:
        return 0
    _ingest_last_id = rows[-1]["id"]
    items = get_targets()
    names = {t["name"] for t in items}
    done = []
    for r in rows:
        n = r["target"]
        if n not in names:
            continue
        lat = r["latency"] if r["success"] else None
        _record_result(n, r["ts"], lat, r["jitter"] or 0)
        done.append(n)
    _evaluate_done(done, items)
    return len(rows)


def ping_tick():
    """Laço "ping": coleta aqui ou só lê o que o coletor externo gravou."""
    global _ingest_last_id
    if external_active("ping"):
        for n, (_t, _ts, f) in list(_inflight.items()):      # sondas internas que ficaram em voo
            f.cancel()
            _inflight.pop(n, None)
        return ingest_pings()
    if "ping" in EXTERNAL:
        _ingest_last_id = None          # na volta para o externo, começa do que existir então
    return ping_cycle()


def mikrotik_tick():
    if external_active("mikrotik"):
        _load_mt_comments()
        cfg = get_mikrotik()
        if cfg["enabled"] and cfg["host"]:
            sync_dhcp_leases()          # promoção de aparelhos do DHCP continua no Python
        return
    mikrotik_once()


def agh_tick():
    if external_active("agh"):
        return
    agh_once()


def _load_mt_comments():
    try:
        v = db.get_meta("mt_comments")
        if v:
            _mt_comment.clear()
            _mt_comment.update(json.loads(v))
    except Exception:
        pass


def external_health():
    """Estado dos módulos do coletor externo (meta collector:*), no formato do worker_health."""
    if not EXTERNAL:
        return []
    out, now = [], time.time()
    alive = _external_alive()
    for mod in sorted(EXTERNAL):
        try:
            r = db.query_w("SELECT value FROM meta WHERE key=?", ("collector:" + mod,))
            h = json.loads(r[0]["value"]) if r else {}
        except Exception:
            h = {}
        iv = h.get("interval") or 60
        last = h.get("last_run")
        stalled = not alive or last is None or now - last > max(iv * 3, 30) + 30
        out.append({"name": "rust:" + mod, "interval": iv, "last_run": last, "last_ok": h.get("last_ok"),
                    "runs": h.get("runs", 0), "errors": h.get("errors", 0), "error": h.get("error"),
                    "status": "stalled" if stalled else ("error" if h.get("error") else "ok")})
    return out


# dependências entre os módulos da coleta: no fim do arquivo porque há ciclos
# (ex.: incidentes avisa pelo Telegram, que consulta os destinos); só são usadas na hora da chamada
from netnoc.coleta.adguard import agh_once  # noqa: E402
from netnoc.coleta.ajustes import get_intervals  # noqa: E402
from netnoc.coleta.alvos import _ancestors, get_targets  # noqa: E402
from netnoc.coleta.incidentes import _hyst, log_event, raise_incident, resolve_incident  # noqa: E402
from netnoc.coleta.mikrotik import _mt_comment, get_mikrotik, mikrotik_once, sync_dhcp_leases  # noqa: E402
