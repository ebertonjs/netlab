"""Rede de segurança (v4.2): backup diário fora do Pi, saúde para o watchdog e vigia externo.

- Backup: todo dia, no horário escolhido, um .tar.gz com netnoc.db (configuração, usuários, senhas
  CIFRADAS), config.json e a exportação JSON vai para o Telegram pelo bot. A chave netnoc.key NUNCA
  entra no arquivo: sem ela as senhas do backup não abrem, então quem pegar o arquivo não lê nada.
  Guarde a chave uma vez, em outro lugar. Restaurar: python manage.py restaurar arquivo.tar.gz
- Saúde: health() diz se o processo está vivo de verdade (banco responde, laços de coleta rodando).
  O /healthz devolve 503 quando não está; o netnoc-watchdog.timer reinicia o serviço.
- Vigia externo: a cada minuto avisa uma URL (healthchecks.io ou compatível). Se o Pi travar, cair a
  luz ou a internet, os avisos param e o serviço manda e-mail/Telegram por conta própria.
"""
import io, json, os, re, sqlite3, tarfile, tempfile, threading, time

import requests

from netnoc.nucleo import db, security

KEY = "guarda"
SECRET = ("hc_url",)
DEFAULTS = {
    "backup_enabled": True,
    "backup_time": "03:30",      # horário local
    "backup_hist": False,        # incluir o histórico (pode ser grande; o Telegram aceita até 50 MB)
    "hc_url": "",                # URL de ping do vigia externo (fica cifrada: quem tem a URL pode mentir que está tudo bem)
}
TG_LIMIT = 49 * 1024 * 1024
_STARTED = time.time()
_lock = threading.Lock()


def get_cfg():
    return security.load_secret_cfg(KEY, DEFAULTS, SECRET)


def valid_time(s):
    return isinstance(s, str) and re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", s) is not None


def valid_hc(u):
    return u == "" or (isinstance(u, str) and re.fullmatch(r"https://[\w.-]{3,100}(:\d{2,5})?/[\w./%~-]{1,300}", u) is not None)


def set_cfg(cfg):
    out = dict(DEFAULTS)
    out.update({k: cfg[k] for k in DEFAULTS if k in cfg})
    if not valid_time(out["backup_time"]):
        raise ValueError("Horário inválido (use HH:MM)")
    if not valid_hc(out["hc_url"]):
        raise ValueError("URL do vigia inválida: use https://… (ex.: https://hc-ping.com/…)")
    out["backup_enabled"] = bool(out["backup_enabled"])
    out["backup_hist"] = bool(out["backup_hist"])
    security.save_secret_cfg(KEY, out, SECRET)


# ------------------------------------------------------------------ backup
def _snapshot(src, dest):
    """Cópia consistente de um SQLite em uso (API de backup: não precisa parar o NetNOC)."""
    s = sqlite3.connect(src, timeout=15)
    d = sqlite3.connect(dest)
    try:
        s.backup(d)
    finally:
        d.close()
        s.close()


def build(include_hist=False):
    """(nome, bytes) do .tar.gz. Levanta exceção se algo essencial faltar."""
    from netnoc.nucleo import backup as bk          # importação tardia: backup importa bot/monitor
    stamp = time.strftime("%Y%m%d-%H%M")
    name = f"netnoc-backup-{stamp}.tar.gz"
    with tempfile.TemporaryDirectory(prefix="netnoc-bkp-") as tmp:
        _snapshot(db.DB_PATH, os.path.join(tmp, "netnoc.db"))
        if include_hist and os.path.exists(db.HIST_PATH):
            _snapshot(db.HIST_PATH, os.path.join(tmp, "netnoc-historico.db"))
        with open(os.path.join(tmp, "netnoc-backup.json"), "w", encoding="utf-8") as f:
            json.dump(bk.export_cfg(), f, ensure_ascii=False, indent=1)
        leia = ("Backup do NetNOC de " + time.strftime("%d/%m/%Y %H:%M") + "\n\n"
                "netnoc.db           configuração, usuários e senhas (cifradas com a netnoc.key)\n"
                "config.json         limites e intervalos\n"
                "netnoc-backup.json  a mesma configuração em JSON, sem senhas (Configurações → Geral → Restaurar)\n"
                + ("netnoc-historico.db medições e incidentes\n" if include_hist else "") +
                "\nA chave netnoc.key NÃO vem aqui. Sem ela as senhas salvas não abrem.\n"
                "Restaurar no Pi:  python manage.py restaurar " + name + "\n")
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as tar:
            for fn in ("netnoc.db", "netnoc-historico.db", "netnoc-backup.json"):
                p = os.path.join(tmp, fn)
                if os.path.exists(p):
                    tar.add(p, arcname=fn)
            if os.path.exists("config.json"):
                tar.add("config.json", arcname="config.json")
            info = tarfile.TarInfo("LEIA-ME.txt")
            raw = leia.encode("utf-8")
            info.size, info.mtime = len(raw), int(time.time())
            tar.addfile(info, io.BytesIO(raw))
    return name, buf.getvalue()


def _tg_document(name, data, caption):
    from netnoc.coleta import monitor
    cfg = monitor.get_telegram()
    if not cfg["bot_token"] or not cfg["chat_id"]:
        raise RuntimeError("Telegram sem token/chat_id")
    if len(data) > TG_LIMIT:
        raise RuntimeError(f"arquivo de {len(data) // 1048576} MB passa do limite do Telegram (50 MB): desligue o histórico no backup")
    try:
        r = requests.post(f"https://api.telegram.org/bot{cfg['bot_token']}/sendDocument",
                          data={"chat_id": cfg["chat_id"], "caption": caption[:1000]},
                          files={"document": (name, data, "application/gzip")}, timeout=120)
    except requests.RequestException as e:
        raise RuntimeError(f"sem conexão com o Telegram ({type(e).__name__})") from None   # nunca str(e): tem o token
    if not r.ok:
        try:
            desc = r.json().get("description", "")
        except ValueError:
            desc = ""
        raise RuntimeError(f"Telegram HTTP {r.status_code} {desc}"[:160])


def run_backup(reason="automático"):
    """Gera e envia. Grava o resultado em meta 'backup_last'. Devolve o dict do resultado."""
    if not _lock.acquire(blocking=False):
        return {"ok": False, "error": "já há um backup em andamento"}
    try:
        cfg = get_cfg()
        res = {"ts": time.time(), "reason": reason}
        try:
            name, data = build(cfg["backup_hist"])
            size = len(data)
            cap = (f"💾 Backup do NetNOC ({reason}) · {size / 1024:.0f} KB\n"
                   "Senhas cifradas: a chave netnoc.key fica fora do arquivo.")
            _tg_document(name, data, cap)
            res.update(ok=True, name=name, size=size)
        except Exception as e:
            res.update(ok=False, error=str(e)[:200])
        db.set_meta("backup_last", json.dumps(res))
        if res["ok"]:
            db.set_meta("backup_last_ok", str(res["ts"]))
        else:
            print(f"[backup] falhou: {res['error']}", flush=True)
        return res
    finally:
        _lock.release()


def last_backup():
    try:
        return json.loads(db.get_meta("backup_last") or "null")
    except ValueError:
        return None


def _due(cfg, now=None):
    """Hora de fazer o backup de hoje? (passou do horário e o último OK é de antes dele)."""
    now = now or time.time()
    if not cfg["backup_enabled"]:
        return False
    hh, mm = map(int, cfg["backup_time"].split(":"))
    lt = time.localtime(now)
    target = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, hh, mm, 0, 0, 0, -1))
    if now < target:
        return False
    last = last_backup() or {}
    if last.get("ts", 0) >= target and (last.get("ok") or now - last["ts"] < 3600):
        return False          # já fez hoje (ou falhou há menos de 1 h: tenta de novo depois)
    return True


# ------------------------------------------------------------------ saúde
_CRITICAL = ("ping", "rollup", "sistema")


def health():
    """(ok, detalhes). Falha = banco não responde ou um laço essencial parou (thread presa)."""
    det = {"uptime_s": round(time.time() - _STARTED)}
    problems = []
    try:
        db.query("SELECT 1")
        db.query("SELECT 1 FROM h.meta LIMIT 1")
    except Exception as e:
        problems.append(f"banco: {type(e).__name__}")
    try:
        from netnoc.coleta import monitor
        if monitor._started and det["uptime_s"] > 300:      # dá tempo dos laços rodarem a 1ª vez
            now = time.time()
            with monitor._hlock:
                hs = {k: dict(v) for k, v in monitor._health.items()}
            for name in _CRITICAL:
                h = hs.get(name)
                iv = (h or {}).get("interval") or 60
                if not h or now - h.get("last_run", 0) > iv * 3 + 180:
                    problems.append(f"laço '{name}' parado")
    except Exception as e:
        problems.append(f"monitor: {type(e).__name__}")
    lb = last_backup()
    if lb:
        det["backup"] = {"ts": lb.get("ts"), "ok": lb.get("ok")}
    det["problems"] = problems
    return not problems, det


# ------------------------------------------------------------------ vigia externo
_hc_state = {"last": None, "ok": None, "error": None}


def hc_ping(ok, detail=""):
    url = get_cfg()["hc_url"]
    if not url:
        return
    try:
        r = requests.post(url + ("" if ok else "/fail"), data=detail[:1000].encode("utf-8"), timeout=10)
        _hc_state.update(last=time.time(), ok=r.ok, error=None if r.ok else f"HTTP {r.status_code}")
    except requests.RequestException as e:
        _hc_state.update(last=time.time(), ok=False, error=type(e).__name__)


def hc_status():
    return dict(_hc_state)


# ------------------------------------------------------------------ laço
def _tick():
    ok, det = health()
    hc_ping(ok, "; ".join(det["problems"]))
    cfg = get_cfg()
    if _due(cfg):
        threading.Thread(target=run_backup, daemon=True, name="backup").start()


def _loop():
    time.sleep(20)
    while True:
        try:
            _tick()
        except Exception as e:
            print(f"[guarda] {type(e).__name__}: {str(e)[:120]}", flush=True)
        time.sleep(60)


_started = False


def start():
    global _started
    if _started:
        return
    _started = True
    threading.Thread(target=_loop, daemon=True, name="guarda").start()
