"""DVR Intelbras (linha MHDX, API HTTP compatível com Dahua) + go2rtc para vídeo ao vivo SOB DEMANDA.

- go2rtc roda como processo filho, escutando só em 127.0.0.1. Só abre o RTSP do DVR quando alguém está
  assistindo e fecha quando a tela de câmeras é fechada.
- A senha do DVR NÃO vai para o arquivo do go2rtc: é passada por variável de ambiente (${NETNOC_DVR_PASS}).
- Em segundo plano, só: eventos do DVR (perda de vídeo, HD) e uma foto de cada canal a cada 10 min
  (a "última imagem" enviada junto com o alerta no Telegram).
"""
import json, os, re, shutil, subprocess, threading, time, urllib.parse
from collections import deque

import requests
from requests.auth import HTTPBasicAuth, HTTPDigestAuth

import db
import security

SECRET = ("password",)
DEFAULTS = {"enabled": False, "host": "", "http_port": 80, "rtsp_port": 554, "use_https": False,
            "username": "", "password": "", "channels": 4, "events": True, "rtsp_template": "", "names": {}}
DEFAULT_TEMPLATE = "rtsp://{user}:{password}@{host}:{rtsp_port}/cam/realmonitor?channel={ch}&subtype={sub}"
GO2RTC_ADDR = os.environ.get("NETNOC_GO2RTC_ADDR", "127.0.0.1:1984")
BASE = os.path.dirname(os.path.abspath(__file__))
CONF_PATH = os.environ.get("NETNOC_GO2RTC_CONF", os.path.join(BASE, "go2rtc.yaml"))
SNAP_EVERY = 600                 # "última imagem" de cada canal a cada 10 min
SRC_RE = re.compile(r"^ch(\d{1,2})(_hd)?$")


# ------------------------------------------------------------------ configuração
def get_cfg():
    cfg = security.load_secret_cfg("dvr", DEFAULTS, SECRET)
    try:
        cfg["channels"] = max(1, min(16, int(cfg.get("channels") or 4)))
    except Exception:
        cfg["channels"] = 4
    if not isinstance(cfg.get("names"), dict):
        cfg["names"] = {}
    return cfg


def masked():
    return security.mask_cfg(get_cfg(), SECRET)


def _valid_user(u):
    return isinstance(u, str) and len(u) <= 64 and not re.search(r"[\s:@/\\\x00-\x1f]", u)


def save_cfg(new):
    old = get_cfg()
    host = str(new.get("host", "")).strip()
    if (new.get("enabled") or host) and not security.valid_host(host):
        raise ValueError("Host do DVR inválido")
    for k in ("http_port", "rtsp_port"):
        if not security.valid_port(new.get(k, DEFAULTS[k])):
            raise ValueError("Porta inválida")
    if not _valid_user(new.get("username", "")):
        raise ValueError("Usuário inválido")
    pw = new.get("password", "")
    if pw != security.MASK and (len(pw) > 128 or any(c in pw for c in "\r\n\x00")):
        raise ValueError("Senha inválida")
    tpl = str(new.get("rtsp_template") or "").strip()
    if tpl and (not tpl.startswith("rtsp://") or "{ch}" not in tpl or len(tpl) > 300 or re.search(r"\s", tpl)):
        raise ValueError("Modelo de URL RTSP inválido (precisa começar com rtsp:// e conter {ch})")
    out = {
        "enabled": bool(new.get("enabled")), "host": host,
        "http_port": int(new.get("http_port", 80)), "rtsp_port": int(new.get("rtsp_port", 554)),
        "use_https": bool(new.get("use_https")), "username": str(new.get("username", "")).strip(),
        "password": pw, "channels": max(1, min(16, int(new.get("channels") or 4))),
        "events": bool(new.get("events", True)), "rtsp_template": tpl, "names": old.get("names", {}),
    }
    out = security.merge_secrets(old, out, SECRET, ("host", "http_port", "rtsp_port", "username"))
    security.save_secret_cfg("dvr", out, SECRET)
    _snap.clear()
    _info_cache.update(ts=0, data=None)
    _restart.set()


def channel_name(cfg, ch):
    n = (cfg.get("names") or {}).get(str(ch))
    return security.clean_name(n, 40) if n else f"Câmera {ch}"


def valid_src(src, cfg=None):
    m = SRC_RE.match(src or "")
    if not m:
        return False
    cfg = cfg or get_cfg()
    return 1 <= int(m.group(1)) <= cfg["channels"]


# ------------------------------------------------------------------ HTTP do DVR (CGI)
def _base(cfg):
    return f"{'https' if cfg['use_https'] else 'http'}://{cfg['host']}:{cfg['http_port']}"


def _get(cfg, path, timeout=6, stream=False):
    """GET com Digest (padrão do DVR) e Basic como reserva."""
    if not cfg.get("host"):
        raise ValueError("DVR não configurado")
    url = _base(cfg) + path
    r = requests.get(url, auth=HTTPDigestAuth(cfg["username"], cfg["password"]), timeout=timeout,
                     stream=stream, verify=False)
    if r.status_code == 401 and "digest" not in r.headers.get("www-authenticate", "").lower():
        r.close()
        r = requests.get(url, auth=HTTPBasicAuth(cfg["username"], cfg["password"]), timeout=timeout,
                         stream=stream, verify=False)
    if r.status_code == 401:
        r.close()
        raise RuntimeError("DVR recusou usuário/senha")
    r.raise_for_status()
    return r


def _text(r):
    """O DVR responde em UTF-8 sem informar charset (o requests assumiria Latin-1: "Portão" -> "PortÃ£o")."""
    return r.content.decode("utf-8", "replace")


def _kv(text):
    out = {}
    for line in (text or "").splitlines():
        k, sep, v = line.strip().partition("=")
        if sep:
            out[k.strip()] = v.strip()
    return out


def _safe_err(e):
    if isinstance(e, requests.HTTPError) and e.response is not None:
        return f"HTTP {e.response.status_code}"
    if isinstance(e, requests.RequestException):
        return type(e).__name__
    return str(e)[:160]


_info_cache = {"ts": 0, "data": None}


def device_info(cfg=None, force=False):
    """Modelo, firmware, nomes dos canais, codecs (principal/extra) e HD. Cache de 10 min."""
    cfg = cfg or get_cfg()
    if not force and _info_cache["data"] and time.time() - _info_cache["ts"] < 600:
        return _info_cache["data"]
    info = {"model": None, "version": None, "channels": [], "hdd": [], "warnings": [], "checks": []}

    def tryget(label, path):
        """Cada consulta é opcional: firmwares da Intelbras variam (alguns devolvem 404 em parte das CGIs)."""
        try:
            txt = _get(cfg, path).content.decode("utf-8", "replace")
            info["checks"].append({"name": label, "ok": True})
            return txt
        except RuntimeError:
            raise                                    # usuário/senha recusados: não adianta continuar
        except Exception as e:
            info["checks"].append({"name": label, "ok": False, "error": _safe_err(e)})
            return ""

    kv = _kv(tryget("Modelo", "/cgi-bin/magicBox.cgi?action=getDeviceType"))
    info["model"] = kv.get("type")
    if not info["model"]:
        si = _kv(tryget("Modelo (alternativo)", "/cgi-bin/magicBox.cgi?action=getSystemInfo"))
        info["model"] = si.get("deviceType") or si.get("updateSerial")
    info["version"] = _kv(tryget("Firmware", "/cgi-bin/magicBox.cgi?action=getSoftwareVersion")).get("version")
    names, enc = {}, {}
    try:
        for k, v in _kv(tryget("Nomes dos canais", "/cgi-bin/configManager.cgi?action=getConfig&name=ChannelTitle")).items():
            m = re.match(r"table\.ChannelTitle\[(\d+)\]\.Name$", k)
            if m:
                names[int(m.group(1)) + 1] = security.clean_name(v, 40)
    except Exception:
        pass
    try:
        for k, v in _kv(tryget("Codecs", "/cgi-bin/configManager.cgi?action=getConfig&name=Encode")).items():
            m = re.match(r"table\.Encode\[(\d+)\]\.(MainFormat|ExtraFormat)\[0\]\.Video\.Compression$", k)
            if m:
                enc.setdefault(int(m.group(1)) + 1, {})["main" if m.group(2) == "MainFormat" else "sub"] = v
    except Exception:
        pass
    for ch in range(1, cfg["channels"] + 1):
        e = enc.get(ch, {})
        info["channels"].append({"ch": ch, "name": names.get(ch) or channel_name(cfg, ch),
                                 "main": e.get("main"), "sub": e.get("sub")})
        for kind, label in (("sub", "stream extra (mosaico)"), ("main", "stream principal (tela cheia)")):
            c = (e.get(kind) or "").upper()
            if "265" in c:
                info["warnings"].append(f"Canal {ch}: {label} em {e.get(kind)}. O navegador não toca H.265 — "
                                        f"mude para H.264 em Câmera → Codificação no DVR.")
    try:
        disks = {}
        for k, v in _kv(tryget("HD", "/cgi-bin/storageDevice.cgi?action=getDeviceAllInfo")).items():
            m = re.match(r"list\.info\[(\d+)\]\.(?:Detail\[\d+\]\.)?(\w+)$", k)
            if m:
                d = disks.setdefault(int(m.group(1)), {"total": 0, "used": 0, "error": False, "state": None})
                if m.group(2) == "TotalBytes":
                    d["total"] += float(v or 0)
                elif m.group(2) == "UsedBytes":
                    d["used"] += float(v or 0)
                elif m.group(2) == "IsError":
                    d["error"] = d["error"] or v.lower() == "true"
                elif m.group(2) == "State":
                    d["state"] = v
        for i, d in sorted(disks.items()):
            info["hdd"].append({"disk": i + 1, "total_gb": round(d["total"] / 1e9, 1), "used_gb": round(d["used"] / 1e9, 1),
                                "used_pct": round(100 * d["used"] / d["total"], 1) if d["total"] else None,
                                "error": d["error"], "state": d["state"]})
            if d["error"]:
                info["warnings"].append(f"HD {i + 1} do DVR com erro.")
    except Exception:
        pass
    if names and names != {int(k): v for k, v in (cfg.get("names") or {}).items()}:  # noqa
        stored = security.load_secret_cfg("dvr", DEFAULTS, ())       # mantém a senha cifrada como está
        stored["names"] = {str(k): v for k, v in names.items()}
        db.set_setting("dvr", json.dumps(stored))
    _info_cache.update(ts=time.time(), data=info)
    return info


# ------------------------------------------------------------------ fotos
_snap = {}                 # ch -> (ts, bytes)   foto recente (cache curto)
_last_good = {}            # ch -> (ts, bytes)   última imagem boa (a cada 10 min)
_slock = threading.Lock()


def snapshot(ch, max_age=2.0, cfg=None):
    cfg = cfg or get_cfg()
    if not cfg["enabled"] or not 1 <= ch <= cfg["channels"]:
        raise ValueError("Canal inválido")
    with _slock:
        hit = _snap.get(ch)
    if hit and time.time() - hit[0] < max_age:
        return hit[1], hit[0]
    r = _get(cfg, f"/cgi-bin/snapshot.cgi?channel={ch}", timeout=8)
    data = r.content
    if not data.startswith(b"\xff\xd8") or len(data) > 4_000_000:
        raise RuntimeError("DVR não devolveu uma imagem JPEG")
    now = time.time()
    with _slock:
        _snap[ch] = (now, data)
    return data, now


def last_good(ch):
    with _slock:
        return _last_good.get(ch)


def _snap_once():
    cfg = get_cfg()
    if not cfg["enabled"] or not cfg["host"]:
        return
    import monitor
    for ch in range(1, cfg["channels"] + 1):
        if ("camera", channel_name(cfg, ch)) in monitor._active_incidents:
            continue                       # sem vídeo agora: mantém a última imagem boa
        try:
            data, ts = snapshot(ch, max_age=30, cfg=cfg)
            with _slock:
                _last_good[ch] = (ts, data)
        except Exception:
            pass
    try:
        device_info(cfg)                   # atualiza nomes/HD (cache de 10 min)
    except Exception:
        pass


# ------------------------------------------------------------------ eventos do DVR
_ev_state = {"connected": False, "since": None, "error": None}
EV_CODES = ("VideoLoss", "StorageFailure", "StorageNotExist", "StorageLowSpace")


def _send_photo_async(ch, name, severity):
    lg = last_good(ch)
    if not lg:
        return
    import monitor
    ts, data = lg
    cap = f"📷 {name}: última imagem antes da queda ({time.strftime('%H:%M', time.localtime(ts))})"
    threading.Thread(target=monitor.send_telegram_photo, args=(data, cap, severity, name), daemon=True).start()


def _handle(code, action, index, cfg):
    import monitor
    start = action.lower() == "start"
    if code == "VideoLoss":
        ch = index + 1
        name = channel_name(cfg, ch)
        if start:
            if ("camera", name) not in monitor._active_incidents:
                monitor.raise_incident("camera", name, f"{name}: perda de vídeo (câmera sem sinal ou desconectada)", "Alta")
                _send_photo_async(ch, name, "Alta")
        else:
            monitor.resolve_incident("camera", name, "Vídeo restabelecido")
    elif code in ("StorageFailure", "StorageNotExist"):
        if start:
            monitor.raise_incident("dvr_hd", "DVR", "DVR: falha no HD ou HD ausente — gravação comprometida", "Alta")
        else:
            monitor.resolve_incident("dvr_hd", "DVR", "HD do DVR normalizado")
    elif code == "StorageLowSpace":
        if start:
            monitor.raise_incident("dvr_hd", "DVR espaço", "DVR: HD com pouco espaço", "Media")
        else:
            monitor.resolve_incident("dvr_hd", "DVR espaço", "Espaço do HD normalizado")


def _reconcile_video_loss(cfg):
    """Ao (re)conectar: o DVR não repete eventos antigos, então pergunta quem está sem vídeo agora."""
    import monitor
    lost = set()
    try:
        txt = _get(cfg, "/cgi-bin/eventManager.cgi?action=getEventIndexes&code=VideoLoss").content.decode("utf-8", "replace")
        lost = {int(v) + 1 for k, v in _kv(txt).items() if k.startswith("channels[") and v.strip().isdigit()}
    except requests.HTTPError:
        lost = set()                          # alguns firmwares devolvem erro quando não há nenhum
    for ch in range(1, cfg["channels"] + 1):
        _handle("VideoLoss", "Start" if ch in lost else "Stop", ch - 1, cfg)
    names = {channel_name(cfg, ch) for ch in range(1, cfg["channels"] + 1)}
    for itype, tgt in list(monitor._active_incidents):
        if itype == "camera" and tgt not in names:
            monitor.resolve_incident("camera", tgt, "Canal removido")


def events_worker():
    backoff = 5
    while True:
        cfg = get_cfg()
        if not (cfg["enabled"] and cfg["host"] and cfg["events"]):
            _ev_state.update(connected=False, error=None)
            time.sleep(10)
            continue
        try:
            _reconcile_video_loss(cfg)
            codes = ",".join(EV_CODES)
            r = _get(cfg, f"/cgi-bin/eventManager.cgi?action=attach&codes=[{codes}]&heartbeat=10",
                     timeout=(6, 40), stream=True)
            _ev_state.update(connected=True, since=time.time(), error=None)
            backoff = 5
            sig = json.dumps([cfg["host"], cfg["http_port"], cfg["username"], cfg["channels"], cfg["events"]])
            for raw in r.iter_lines(chunk_size=1, decode_unicode=False):
                if _restart_events.is_set():
                    _restart_events.clear()
                    break
                line = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else raw
                m = re.search(r"Code=(\w+);action=(\w+);index=(\d+)", line)
                if m and m.group(1) in EV_CODES:
                    _handle(m.group(1), m.group(2), int(m.group(3)), cfg)
                cur = get_cfg()
                if json.dumps([cur["host"], cur["http_port"], cur["username"], cur["channels"], cur["events"]]) != sig:
                    break
            r.close()
        except Exception as e:
            _ev_state.update(connected=False, error=_safe_err(e))
            time.sleep(backoff)
            backoff = min(backoff * 2, 120)
        else:
            _ev_state.update(connected=False)
            time.sleep(1)


# ------------------------------------------------------------------ go2rtc (processo filho)
_proc = None
_plock = threading.Lock()
_restart = threading.Event()
_restart_events = threading.Event()
_log = deque(maxlen=40)
_gstate = {"started": None, "restarts": 0, "error": None}


def find_binary():
    cands = [os.environ.get("NETNOC_GO2RTC"), os.path.join(BASE, "bin", "go2rtc"), shutil.which("go2rtc")]
    for c in cands:
        if c and os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    return None


def _stream_url(cfg, ch, sub):
    tpl = cfg.get("rtsp_template") or DEFAULT_TEMPLATE
    # usuário e senha entram como variáveis: o arquivo do go2rtc não guarda a senha
    return (tpl.replace("{user}", "${NETNOC_DVR_USER}").replace("{password}", "${NETNOC_DVR_PASS}")
            .replace("{host}", cfg["host"]).replace("{rtsp_port}", str(cfg["rtsp_port"]))
            .replace("{ch}", str(ch)).replace("{sub}", str(sub)))


def _write_conf(cfg):
    streams = {}
    for ch in range(1, cfg["channels"] + 1):
        streams[f"ch{ch}"] = _stream_url(cfg, ch, 1)          # stream extra: mosaico
        streams[f"ch{ch}_hd"] = _stream_url(cfg, ch, 0)       # principal: tela cheia
    conf = {
        "api": {"listen": GO2RTC_ADDR, "origin": ""},
        "rtsp": {"listen": ""}, "webrtc": {"listen": ""}, "srtp": {"listen": ""},
        "log": {"level": "warn", "format": "text"},
        "streams": streams,
    }
    tmp = CONF_PATH + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(conf, f, indent=1)          # JSON é YAML válido
    os.replace(tmp, CONF_PATH)


def _reader(p):
    for line in iter(p.stdout.readline, b""):
        _log.append(line.decode("utf-8", "replace").rstrip()[:300])


def _stop_proc():
    global _proc
    p = _proc
    _proc = None
    if p and p.poll() is None:
        p.terminate()
        try:
            p.wait(5)
        except Exception:
            p.kill()


def go2rtc_once():
    """Chamado a cada 5 s pelo laço supervisionado: mantém o go2rtc vivo e em dia com a configuração."""
    global _proc
    cfg = get_cfg()
    import hashlib
    sig = hashlib.sha256(json.dumps([cfg["enabled"], cfg["host"], cfg["rtsp_port"], cfg["username"], cfg["password"],
                                     cfg["channels"], cfg["rtsp_template"]]).encode()).hexdigest()
    with _plock:
        want = cfg["enabled"] and cfg["host"] and find_binary()
        if _gstate.get("sig") not in (None, sig):
            _restart.set()                    # configuração mudou (tela de config ou restore de backup)
        _gstate["sig"] = sig
        if _restart.is_set():
            _restart.clear()
            _restart_events.set()
            _stop_proc()
        if not want:
            _stop_proc()
            _gstate["error"] = None if not cfg["enabled"] else ("go2rtc não instalado (rode ./install.sh)" if not find_binary() else None)
            return
        if _proc is not None and _proc.poll() is None:
            return
        if _proc is not None:
            _gstate["restarts"] += 1
            _gstate["error"] = "go2rtc encerrou: " + (" | ".join(list(_log)[-2:]) or "sem detalhes")
        _write_conf(cfg)
        env = dict(os.environ, NETNOC_DVR_USER=urllib.parse.quote(cfg["username"], safe=""),
                   NETNOC_DVR_PASS=urllib.parse.quote(cfg["password"], safe=""))
        _proc = subprocess.Popen([find_binary(), "-config", CONF_PATH], cwd=BASE, env=env,
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
        _gstate["started"] = time.time()
        threading.Thread(target=_reader, args=(_proc,), daemon=True, name="go2rtc-log").start()


def go2rtc_status():
    p = _proc
    return {"binary": bool(find_binary()), "running": bool(p and p.poll() is None),
            "started": _gstate["started"], "restarts": _gstate["restarts"], "error": _gstate["error"]}


def viewers():
    """Quantas conexões de vídeo estão abertas agora (diagnóstico: 0 = nenhum stream rodando)."""
    try:
        r = requests.get(f"http://{GO2RTC_ADDR}/api/streams", timeout=2, proxies={"http": None, "https": None})
        n = 0
        for s in (r.json() or {}).values():
            n += len((s or {}).get("consumers") or [])
        return n
    except Exception:
        return None


def status():
    import monitor
    cfg = get_cfg()
    chans = []
    for ch in range(1, cfg["channels"] + 1):
        name = channel_name(cfg, ch)
        lg = last_good(ch)
        chans.append({"ch": ch, "name": name, "loss": ("camera", name) in monitor._active_incidents,
                      "last_good": lg[0] if lg else None})
    info = _info_cache["data"] or {}
    return {"enabled": cfg["enabled"], "host": cfg["host"], "channels": chans,
            "events": dict(_ev_state, enabled=cfg["events"]), "go2rtc": go2rtc_status(),
            "model": info.get("model"), "version": info.get("version"), "hdd": info.get("hdd") or [],
            "warnings": info.get("warnings") or []}


def test():
    cfg = get_cfg()
    if not cfg["host"]:
        raise ValueError("Configure o host do DVR")
    info = device_info(cfg, force=True)
    ok_snap, snap_err = 0, None
    for ch in range(1, cfg["channels"] + 1):
        try:
            snapshot(ch, max_age=0, cfg=cfg)
            ok_snap += 1
        except Exception as e:
            snap_err = snap_err or _safe_err(e)
    info["checks"].append({"name": "Fotos (snapshot)", "ok": ok_snap > 0, "error": None if ok_snap else snap_err})
    info["checks"].append({"name": "Vídeo ao vivo (RTSP via go2rtc)", "ok": go2rtc_status()["running"],
                           "error": None if go2rtc_status()["running"] else (go2rtc_status()["error"] or "go2rtc parado")})
    if not any(c["ok"] for c in info["checks"]):
        raise RuntimeError("o DVR não respondeu a nenhuma consulta: " +
                           "; ".join(f'{c["name"]}: {c.get("error")}' for c in info["checks"][:3]))
    return dict(info, snapshots_ok=ok_snap, go2rtc=go2rtc_status())


_started = False


def start():
    global _started
    if _started:
        return
    _started = True
    import monitor
    for name, once, iv, delay in (("go2rtc", go2rtc_once, lambda: 5, 1), ("cameras_foto", _snap_once, lambda: SNAP_EVERY, 20)):
        threading.Thread(target=monitor._loop, args=(name, once, iv, delay), daemon=True, name=name).start()
    threading.Thread(target=events_worker, daemon=True, name="dvr-eventos").start()


def shutdown():
    with _plock:
        _stop_proc()
