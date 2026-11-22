# Bot do Telegram (`netnoc/bot`)

O mesmo bot que manda os alertas também conversa e, com a sua permissão, age no roteador.

| Arquivo | O que faz |
|---|---|
| `aibot.py` | Leitura das mensagens do Telegram (long polling, só o Chat ID configurado), comandos (`/status`, `/ping`, `/trace`, `/alertas`, `/mk`, `/diagnostico`, `/diario`, `/banda`, `/aparelhos`, `/bloqueados`, `/pppoe`, `/acordar`, `/bloquear`, `/desbloquear`), perguntas em português com **IA opcional** (Google Gemini ou Groq, com ferramentas só de leitura), memória curta da conversa, botões **Sim/Cancelar** das ações e aviso de aparelho novo. |
| `ferramentas.py` · `ia.py` · `comandos.py` · `confirmar.py` | (v4.4) Partes que saíram do `aibot.py`: ferramentas de consulta da IA; conversa com Gemini/Groq; comandos sem IA; ações com botões Sim/Cancelar e aviso de aparelho novo. O `aibot.py` fica com a configuração, o Telegram e o `handle`, e reexporta o resto. |
| `actions.py` | O que o bot pode fazer no MikroTik: reiniciar o PPPoE, Wake-on-LAN (pelo servidor e pelo roteador), bloquear/desbloquear aparelho (lista `netnoc-bloqueados` + regra "NetNOC" no topo do firewall), quem está usando a banda (torch ou taxa das conexões), a lista de aparelhos e, desde a v4.1, desligar/ligar portas com volta automática agendada no MikroTik, reiniciar MikroTik/DVR/servidor/NetNOC e as fotos das câmeras. |

**Usa:** núcleo, coleta, análise. **Usado por:** web (configuração e teste pela tela), análise (diário), coleta (gancho de aparelho novo).

## Segurança
- Responde só ao Chat ID configurado; os botões só valem nesse chat, expiram (3 min; 1 h no aviso de aparelho novo) e não executam duas vezes.
- Ações vêm **desligadas**; ligadas, nunca executam sem o "Sim". A IA só pode pedir a confirmação, nunca executar.
- Não bloqueia o roteador, o próprio servidor nem IP público. Tudo vai para a auditoria e para os eventos.
- Chaves das IAs cifradas no banco e fora do backup; erros nunca mostram chave nem token.

## Mudanças
- **v4.4** — `aibot.py` dividido em `ferramentas.py`, `ia.py`, `comandos.py` e `confirmar.py`.
- **v4.3** — `/medir`, `/log`; ferramentas da IA `medir_velocidade` e `log_mikrotik`.
- **v4.2** — `/backup`, `/saude`.
- **v4.1** — ações novas: fotos das câmeras (`cameras`), portas do MikroTik (`portas`, desligar/ligar com volta automática agendada no RouterOS e proteção da porta do servidor), reinícios (MikroTik, DVR, servidor, NetNOC e "tudo" em ordem segura, com aviso na volta). A ferramenta `acao` da IA ganhou essas ações; comandos `/cameras`, `/portas`, `/desligar`, `/religar`, `/reiniciar`.
- **v4.0** — a ferramenta `speedtest` da IA virou `banda_wan` (pico de download/upload da WAN hoje, em 7 e 30 dias).
- **v3.12** — pasta própria. `actions.py` novo; botões de confirmação (callback do Telegram); comandos de ação, `/banda`, `/aparelhos`, `/bloqueados`; aviso de aparelho novo com "Bloquear / É meu"; ferramentas `banda`, `aparelhos`, `acao` para a IA.
- **v3.11** — `/diagnostico`, `/diario` e ferramentas `diagnosticar` e `diagnosticos`.
- **v3.10** — bot e IA criados (Gemini e Groq com cota grátis), teste pela tela. Modelos padrão atualizados (`gemini-3.5-flash-lite`, `openai/gpt-oss-120b`) e correção da colisão de parâmetro que impedia a leitura das mensagens.

## Melhorias desta versão
- Toda ação passa pelo mesmo caminho (propor → confirmar → executar → auditar), seja por comando, pela IA ou pelo aviso de aparelho novo.
- Mensagens de erro do MikroTik traduzidas (ex.: "o usuário não tem permissão de escrita").

## Próximas melhorias
- `/relatorio` com SLA do mês e envio programado.
- Bloqueio por MAC (sobrevive à troca de IP) usando o DHCP do MikroTik.
- Responder no grupo só a membros autorizados.
