"""Telegram, bot/IA, outros canais de notificação e janelas de manutenção."""
import time
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from netnoc.alertas import notifier
from netnoc.bot import aibot
from netnoc.coleta import monitor
from netnoc.nucleo import security
from netnoc.web.comum import audit, need_admin

router = APIRouter()


class TelegramIn(BaseModel):
    enabled: bool
    bot_token: str = ""
    chat_id: str = ""
    min_severity: str = "Alta"


@router.get("/api/settings/telegram")
def get_telegram_ep():
    return security.mask_cfg(monitor.get_telegram(), ("bot_token",))


@router.post("/api/settings/telegram")
def set_telegram_ep(data: TelegramIn, request: Request):
    if data.min_severity not in ("Alta", "Media", "Baixa", "Info"):
        raise HTTPException(400, "Severidade inválida")
    old = monitor.get_telegram()
    try:
        new = security.merge_secrets(old, data.dict(), ("bot_token",))
    except ValueError as e:
        raise HTTPException(400, str(e))
    monitor.set_telegram(new["enabled"], new["bot_token"], new["chat_id"], new["min_severity"])
    audit(request, "telegram")
    return {"ok": True}


@router.post("/api/settings/telegram/test")
def test_telegram_ep():
    if not monitor.send_telegram(f"✅ Teste de alerta {monitor.get_app_name()} — configuração funcionando!"):
        raise HTTPException(400, "Não foi possível enviar. Confira o token e chat_id.")
    return {"ok": True}


class AiBotIn(BaseModel):
    enabled: bool = False
    provider: str = "none"
    gemini_key: str = ""
    gemini_model: str = ""
    groq_key: str = ""
    groq_model: str = ""
    any_host: bool = True
    diary: bool = False
    diary_time: str = "07:00"
    actions: bool = False
    new_devices: bool = True
    actions_ports: bool = False
    actions_reboot: bool = False
    revert_min: int = 5
    restart_all: List[str] = ["mikrotik", "dvr"]


@router.get("/api/settings/aibot")
def get_aibot_ep():
    tg = monitor.get_telegram()
    return {**security.mask_cfg(aibot.get_cfg(), aibot.SECRET), "status": {k: v for k, v in aibot.status().items() if k != "thread"},
            "telegram_ready": bool(tg.get("bot_token") and tg.get("chat_id")),
            "sudo_ok": _sudo_ok()}


def _sudo_ok():
    from netnoc.bot import actions
    return actions.can_sudo("systemctl", "reboot") and actions.can_sudo("systemctl", "restart", "netnoc")


@router.post("/api/settings/aibot")
def set_aibot_ep(data: AiBotIn, request: Request):
    new = security.merge_secrets(aibot.get_cfg(), data.dict(), aibot.SECRET)
    try:
        aibot.set_cfg(new)
    except ValueError as e:
        raise HTTPException(400, str(e))
    audit(request, "aibot", new["provider"])
    return {"ok": True}


class AiAskIn(BaseModel):
    question: str = ""


@router.post("/api/settings/aibot/test")
def test_aibot_ep(data: AiAskIn, request: Request):
    """Pergunta de teste pela interface (mesmo caminho do Telegram, sem precisar do celular)."""
    q = (data.question or "").strip()[:500] or "Me dá um resumo rápido da rede agora."
    t0 = time.time()
    try:
        if q.startswith("/"):
            r = aibot.handle(q, "painel")
            if isinstance(r, tuple):        # ação: aqui só mostra o que seria pedido (confirmação é pelo Telegram)
                r = r[0] + ("\n\n(As ações são confirmadas com os botões no Telegram.)" if r[1] else "")
                aibot._pending.clear()
            return {"ok": True, "answer": r, "tools": [], "secs": round(time.time() - t0, 1)}
        answer, used = aibot.ask(q, chat="painel")
    except RuntimeError as e:
        raise HTTPException(400, str(e))
    audit(request, "aibot_test")
    return {"ok": True, "answer": answer, "tools": used, "secs": round(time.time() - t0, 1)}


# ------------------------------------------------------------ notificações
@router.get("/api/settings/notify")
def notify_get(request: Request):
    need_admin(request)
    return notifier.masked_config()


@router.post("/api/settings/notify")
def notify_set(data: dict, request: Request):
    try:
        notifier.save_config(data)
    except ValueError as e:
        raise HTTPException(400, str(e))
    audit(request, "notify")
    return {"ok": True}


@router.post("/api/settings/notify/test/{channel}")
def notify_test(channel: str, request: Request):
    if channel not in notifier.CHANNELS:
        raise HTTPException(404, "Canal desconhecido")
    try:
        notifier.send_channel(channel, "Info", f"✅ Teste de alerta {monitor.get_app_name()} — canal funcionando!", None, "test")
    except Exception as e:
        raise HTTPException(400, f"Falha: {notifier._safe_err(e)}")
    audit(request, "notify-test", channel)
    return {"ok": True}


class MaintIn(BaseModel):
    name: str
    start: float
    end: float
    targets: Optional[List[str]] = None


@router.get("/api/maintenance")
def maint_list():
    return notifier.get_maintenance()


@router.post("/api/maintenance")
def maint_add(item: MaintIn, request: Request):
    try:
        m = notifier.add_maintenance(item.name, item.start, item.end, item.targets)
    except (ValueError, TypeError) as e:
        raise HTTPException(400, str(e))
    audit(request, "maintenance+", item.name)
    return m


@router.delete("/api/maintenance/{mid}")
def maint_del(mid: str, request: Request):
    notifier.remove_maintenance(mid)
    audit(request, "maintenance-", mid)
    return {"ok": True}
