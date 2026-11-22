"""Envio de alertas pelo Telegram (texto e foto), respeitando severidade mínima e manutenção.

Parte do antigo monitor.py (v4.4); o monitor.py continua reexportando tudo."""
import threading


import requests

from netnoc.nucleo import security

# ------------------------------------------------------------------ telegram
_TG_SECRET = ("bot_token",)
_TG_DEFAULTS = {"enabled": False, "bot_token": "", "chat_id": "", "min_severity": "Alta"}
_SEVERITY_ORDER = {"Alta": 3, "Media": 2, "Baixa": 1, "Info": 0}


def get_telegram():
    return security.load_secret_cfg("telegram", _TG_DEFAULTS, _TG_SECRET)


def set_telegram(enabled, bot_token, chat_id, min_severity):
    security.save_secret_cfg("telegram", {
        "enabled": bool(enabled), "bot_token": bot_token or "",
        "chat_id": chat_id or "", "min_severity": min_severity or "Alta"}, _TG_SECRET)


_tg_last_error = [""]


def send_telegram(message):
    """True/False; o motivo da última falha fica em telegram_last_error() (sem o token)."""
    cfg = get_telegram()
    if not cfg["enabled"] or not cfg["bot_token"] or not cfg["chat_id"]:
        _tg_last_error[0] = "Telegram desativado ou sem token/chat_id"
        return False
    try:
        url = f"https://api.telegram.org/bot{cfg['bot_token']}/sendMessage"
        r = requests.post(url, data={"chat_id": cfg["chat_id"], "text": message}, timeout=8)
        if r.ok:
            _tg_last_error[0] = ""
            return True
        try:
            desc = r.json().get("description", "")
        except Exception:
            desc = ""
        _tg_last_error[0] = f"HTTP {r.status_code} {desc}"[:160]
        return False
    except Exception as e:
        # nunca str(e): a exceção do requests traz a URL, que contém o token do bot
        _tg_last_error[0] = type(e).__name__
        return False


def telegram_last_error():
    return _tg_last_error[0]


def send_telegram_photo(jpeg, caption, severity="Alta", target=None):
    """Foto (ex.: última imagem da câmera) respeitando ativação, severidade mínima e manutenção."""
    cfg = get_telegram()
    if not cfg["enabled"] or not cfg["bot_token"] or not cfg["chat_id"]:
        return False
    if _SEVERITY_ORDER.get(severity, 0) < _SEVERITY_ORDER.get(cfg["min_severity"], 3):
        return False
    try:
        from netnoc.alertas import notifier
        if target and notifier.in_maintenance(target):
            return False
    except Exception:
        pass
    try:
        r = requests.post(f"https://api.telegram.org/bot{cfg['bot_token']}/sendPhoto",
                          data={"chat_id": cfg["chat_id"], "caption": caption[:1000]},
                          files={"photo": ("camera.jpg", jpeg, "image/jpeg")}, timeout=20)
        return r.ok
    except Exception:
        return False


def notify(severity, text, kind="incident", target=None):
    """Ponto único de saída de alertas (o módulo notifier, se presente, assume)."""
    try:
        from netnoc.alertas import notifier
        return notifier.dispatch(severity, text, kind, target)
    except ImportError:
        cfg = get_telegram()
        if cfg["enabled"] and _SEVERITY_ORDER.get(severity, 0) >= _SEVERITY_ORDER.get(cfg["min_severity"], 3):
            threading.Thread(target=send_telegram, args=(text,), daemon=True).start()

