"""Conversa com a IA (Gemini ou Groq): prompt do sistema, chamadas de ferramenta, histórico curto.

Parte do antigo aibot.py (v4.4); o aibot.py continua reexportando tudo."""
import json, re, time
from collections import deque
from datetime import datetime

import requests

from netnoc.coleta import monitor

# ------------------------------------------------------------------ IA
def _system_prompt():
    names = ", ".join(t["name"] for t in monitor.get_targets()) or "nenhum"
    return (
        f"Você é o assistente do {monitor.get_app_name()}, o painel de monitoramento da rede do usuário. "
        f"Agora são {datetime.now().strftime('%d/%m/%Y %H:%M')}. Destinos cadastrados: {names}.\n"
        "Regras:\n"
        "- Responda em português do Brasil, curto e direto, como um analista de NOC falando com o dono da rede.\n"
        "- Texto puro para o Telegram: NADA de markdown (sem **, #, ``` ou tabelas). Use quebras de linha e poucos emojis (✅ ⚠️ ❌ 📶).\n"
        "- Para qualquer dado da rede use as ferramentas. Nunca invente números. Se uma ferramenta der erro, diga qual.\n"
        "- No ping, compare com o histórico de 24h quando houver e diga se está normal, pior ou melhor.\n"
        "- Para 'por que caiu' ou 'o que aconteceu' use diagnosticos; para investigar um problema agora use diagnosticar.\n"
        "- Ações (PPPoE, portas, reinícios, bloquear, acordar) só pela ferramenta acao, que envia botões de confirmação. Nunca diga que executou: diga que mandou o pedido de confirmação.\n"
        "- 'Reinicia tudo' = acao reiniciar_tudo (uma confirmação só). 'Desabilita o PPPoE' = desligar_porta com porta='pppoe'. "
        "Para achar uma porta pelo que ela liga ('a porta do roteador', 'o AP'), passe essa palavra em porta; se não achar, use portas e pergunte.\n"
        "- 'Testa a velocidade', 'mede a internet' = medir_velocidade; diga para rodar o speedtest agora e que o resultado chega sozinho.\n"
        "- 'Manda as câmeras' / 'foto do portão' = ferramenta cameras (as fotos vão direto no chat); depois responda só uma frase curta.\n"
        "- Latência: até 30 ms ótima, 30–80 ms ok, acima de 100 ms ruim. Perda acima de 1% merece atenção.\n"
        "- Se o pedido não tiver relação com a rede, responda em uma frase que você cuida só do monitoramento."
    )


def _decls_openai():
    return [{"type": "function", "function": {"name": n, "description": d,
             "parameters": {"type": "object", "properties": p, "required": r}}} for n, _, d, p, r in TOOLS]


def _decls_gemini():
    out = []
    for n, _, d, p, r in TOOLS:
        dd = {"name": n, "description": d}
        if p:
            dd["parameters"] = {"type": "object", "properties": p, "required": r}
        out.append(dd)
    return [{"functionDeclarations": out}]


def _http_err(r, who):
    try:
        j = r.json()
        msg = (j.get("error") or {}).get("message") if isinstance(j.get("error"), dict) else j.get("error")
    except Exception:
        msg = ""
    code = {400: "requisição recusada", 401: "chave inválida", 403: "chave sem permissão", 404: "modelo não encontrado",
            429: "limite da cota grátis atingido, tente em 1 minuto"}.get(r.status_code, f"HTTP {r.status_code}")
    msg = re.sub(r"(AIza|gsk_)[A-Za-z0-9_\-]+", "***", str(msg or ""))[:160]
    return RuntimeError(f"{who}: {code}" + (f" ({msg})" if msg and r.status_code not in (401, 429) else ""))


def _post(url, headers, body, who):
    try:
        r = requests.post(url, headers=headers, json=body, timeout=45)
    except requests.Timeout:
        raise RuntimeError(f"{who}: sem resposta (timeout)")
    except Exception as e:
        raise RuntimeError(f"{who}: {type(e).__name__}")
    if not r.ok:
        raise _http_err(r, who)
    return r.json()


def ask_groq(cfg, history, question, tools=True):
    msgs = [{"role": "system", "content": _system_prompt()}]
    msgs += [{"role": "user" if role == "u" else "assistant", "content": txt} for _, role, txt in history]
    msgs.append({"role": "user", "content": question})
    url = "https://api.groq.com/openai/v1/chat/completions"
    hdr = {"Authorization": f"Bearer {cfg['groq_key']}"}
    used = []
    for _ in range(MAX_ROUNDS + 1):
        body = {"model": cfg["groq_model"], "messages": msgs, "temperature": 0.3, "max_tokens": 2048}
        if cfg["groq_model"].startswith("openai/gpt-oss"):
            body["reasoning_effort"] = "low"      # raciocínio curto: resposta mais rápida e sem estourar max_tokens
        if tools and len(used) < MAX_ROUNDS:
            body["tools"], body["tool_choice"] = _decls_openai(), "auto"
        j = _post(url, hdr, body, "Groq")
        m = (j.get("choices") or [{}])[0].get("message") or {}
        calls = m.get("tool_calls") or []
        if not calls:
            txt = (m.get("content") or "").strip()
            if not txt:
                raise RuntimeError("Groq: resposta vazia (" + str((j.get("choices") or [{}])[0].get("finish_reason")) + ")")
            return txt, used
        msgs.append({"role": "assistant", "content": m.get("content") or "", "tool_calls": calls})
        for c in calls:
            fn = c.get("function") or {}
            try:
                args = json.loads(fn.get("arguments") or "{}")
            except ValueError:
                args = {}
            used.append(fn.get("name"))
            res = run_tool(fn.get("name"), args)
            msgs.append({"role": "tool", "tool_call_id": c.get("id"), "content": json.dumps(res, ensure_ascii=False, default=str)[:12000]})
    return "Não consegui fechar a resposta (muitas consultas). Tente uma pergunta mais específica.", used


def ask_gemini(cfg, history, question, tools=True):
    contents = [{"role": "user" if role == "u" else "model", "parts": [{"text": txt}]} for _, role, txt in history]
    contents.append({"role": "user", "parts": [{"text": question}]})
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{cfg['gemini_model']}:generateContent"
    hdr = {"x-goog-api-key": cfg["gemini_key"]}
    used = []
    for _ in range(MAX_ROUNDS + 1):
        body = {"systemInstruction": {"parts": [{"text": _system_prompt()}]}, "contents": contents,
                "generationConfig": {"maxOutputTokens": 4096}}   # Gemini 3 recomenda a temperatura padrão
        if tools and len(used) < MAX_ROUNDS:
            body["tools"] = _decls_gemini()
        j = _post(url, hdr, body, "Gemini")
        cand = (j.get("candidates") or [{}])[0]
        content = cand.get("content") or {}
        parts = content.get("parts") or []
        calls = [p["functionCall"] for p in parts if "functionCall" in p]
        if not calls:
            txt = "".join(p.get("text", "") for p in parts if not p.get("thought")).strip()
            if not txt and cand.get("finishReason") not in (None, "STOP"):
                raise RuntimeError(f"Gemini: resposta bloqueada ({cand.get('finishReason')})")
            return txt, used
        contents.append({"role": "model", "parts": parts})   # devolve como veio (inclui thoughtSignature)
        resp = []
        for c in calls:
            used.append(c.get("name"))
            res = run_tool(c.get("name"), c.get("args") or {})
            resp.append({"functionResponse": {"name": c.get("name"), "response": {"resultado": res}}})
        contents.append({"role": "user", "parts": resp})
    return "Não consegui fechar a resposta (muitas consultas). Tente uma pergunta mais específica.", used


def ask(question, chat="test", cfg=None, tools=True):
    cfg = cfg or get_cfg()
    p = cfg["provider"]
    if p == "gemini" and cfg["gemini_key"]:
        fn = ask_gemini
    elif p == "groq" and cfg["groq_key"]:
        fn = ask_groq
    else:
        raise RuntimeError("IA não configurada")
    now = time.time()
    h = _hist.setdefault(chat, deque(maxlen=HIST_LEN))
    while h and now - h[0][0] > HIST_TTL:
        h.popleft()
    txt, used = fn(cfg, list(h), question, tools)
    txt = _plain(txt) or "Sem resposta da IA."
    h.append((now, "u", question[:1000]))
    h.append((now, "a", txt[:1500]))
    return txt, used


def _plain(t):
    """Tira o markdown que escapar (o Telegram mostraria os asteriscos)."""
    t = re.sub(r"```[a-z]*\n?", "", t or "")
    t = re.sub(r"\*\*(.+?)\*\*", r"\1", t)
    t = re.sub(r"(?m)^#{1,6}\s*", "", t)
    t = re.sub(r"(?m)^\s*[-*]\s+", "• ", t)
    return t.strip()


# dependências entre os módulos do bot: no fim do arquivo porque há ciclos (só usadas na hora da chamada)
from netnoc.bot.aibot import HIST_LEN, HIST_TTL, MAX_ROUNDS, _hist, get_cfg  # noqa: E402
from netnoc.bot.ferramentas import TOOLS, run_tool  # noqa: E402
