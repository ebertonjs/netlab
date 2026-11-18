# Web (`netnoc/web`)

A API e as páginas. Não coleta nem decide nada: junta o que os outros módulos produzem e entrega para a interface, o Modo TV, o bot e as integrações.

| Arquivo | O que faz |
|---|---|
| `app.py` | Aplicação **FastAPI** (≈120 rotas): página inicial (`/api/home`, com a narrativa), destinos, histórico, incidentes, eventos, DNS, MikroTik, AdGuard, câmeras (incl. WebSocket do vídeo), topologia e **mapa no passado** (`/api/topomap?at=`, `/api/timemachine`), diagnóstico sob demanda (`/api/diagnose`), linha do tempo (`/api/story`), diário (`/api/diary/test`), banda (`/api/bandwidth`), configurações (Telegram, bot/IA, integrações, temas), SLA, backup, auditoria, agentes remotos, status público, `/metrics` e as páginas em `static/`. Na partida liga a coleta, o diagnóstico, o diário, o bot e as câmeras. |

O `main.py` da raiz só importa `app` daqui, para o serviço continuar com `uvicorn main:app`.

**Usa:** todos os módulos. **Usado por:** a interface (`static/`), o Modo TV, scripts e agentes.

## Mudanças
- **v3.12** — vira `netnoc/web/app.py` (era `main.py`). `/api/topomap` aceita `?at=` (máquina do tempo) com os incidentes e a causa daquele momento; `/api/timemachine`, `/api/bandwidth`; bot com opções de ações e aviso de aparelho novo.
- **v3.11** — `/api/story`, `/api/diagnoses`, `/api/diagnose`, `/api/diary/test`; narrativa dentro de `/api/home`.
- **v3.10** — configuração e teste do bot/IA.
- **v3.5** — `/api/topomap`. **v3.4** — `/api/home`. **v3.3** — interface nova, temas, câmeras, `/api/health/workers`.

## Melhorias desta versão
- Ponto de entrada separado do código: dá para reorganizar o pacote sem mexer no serviço do Pi, no `install.sh` ou no `reinstalar.sh`.
- O mapa ao vivo e o mapa no passado saem da mesma função (`_topomap`).

## Próximas melhorias
- Dividir `app.py` (≈1800 linhas) em roteadores por assunto (`APIRouter`): destinos, integrações, configurações, câmeras, análise.
- Documentação OpenAPI opcional para quem quiser integrar.
