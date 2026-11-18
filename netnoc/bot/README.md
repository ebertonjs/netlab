# Bot do Telegram (`netnoc/bot`)

O mesmo bot que manda os alertas também conversa e, com a sua permissão, age no roteador.

| Arquivo | O que faz |
|---|---|
| `aibot.py` | Leitura das mensagens do Telegram (long polling, só o Chat ID configurado), comandos (`/status`, `/ping`, `/trace`, `/alertas`, `/mk`, `/diagnostico`, `/diario`, `/banda`, `/aparelhos`, `/bloqueados`, `/pppoe`, `/acordar`, `/bloquear`, `/desbloquear`), perguntas em português com **IA opcional** (Google Gemini ou Groq, com ferramentas só de leitura), memória curta da conversa, botões **Sim/Cancelar** das ações e aviso de aparelho novo. |
| `actions.py` | O que o bot pode fazer no MikroTik: reiniciar o PPPoE, Wake-on-LAN (pelo servidor e pelo roteador), bloquear/desbloquear aparelho (lista `netnoc-bloqueados` + regra "NetNOC" no topo do firewall), quem está usando a banda (torch ou taxa das conexões) e a lista de aparelhos. |

**Usa:** núcleo, coleta, análise. **Usado por:** web (configuração e teste pela tela), análise (diário), coleta (gancho de aparelho novo).

## Segurança
- Responde só ao Chat ID configurado; os botões só valem nesse chat, expiram (3 min; 1 h no aviso de aparelho novo) e não executam duas vezes.
- Ações vêm **desligadas**; ligadas, nunca executam sem o "Sim". A IA só pode pedir a confirmação, nunca executar.
- Não bloqueia o roteador, o próprio servidor nem IP público. Tudo vai para a auditoria e para os eventos.
- Chaves das IAs cifradas no banco e fora do backup; erros nunca mostram chave nem token.

## Mudanças
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
