# Web (`netnoc/web`)

A API e as páginas. Não coleta nem decide nada: junta o que os outros módulos produzem e entrega para a interface, o Modo TV, o bot e as integrações.

| Arquivo | O que faz |
|---|---|
| `app.py` | Só a montagem: cria o FastAPI, liga o middleware de segurança, inclui as rotas e, na partida, liga a coleta, o diagnóstico, o diário, o bot e as câmeras. |
| `middleware.py` | Auditoria automática de toda alteração (e do 403), gzip com cache dos arquivos comprimidos (sem tocar no SSE e no vídeo) e cache imutável dos arquivos com `?v=`. |
| `comum.py` | O que as rotas compartilham: versão, configuração, auditoria (`audit`), períodos (`secs`), permissão (`need_admin`). |
| `rotas/sistema.py` | `/api/me` e preferências, versão e sistema, usuários, auditoria, segredos, backup/restauração, Prometheus (`/metrics`), dados do histórico, intervalos, nome, modo do tema |
| `rotas/metricas.py` | visão geral, histórico de latência/perda, destinos, DNS, incidentes, eventos, SLA, tempo real (SSE) |
| `rotas/painel.py` | página inicial com a narrativa e o pico da WAN, diagnóstico sob demanda, diário, mapa e máquina do tempo |
| `rotas/destinos.py` | cadastro de destinos e DNS, aparelhos do DHCP |
| `rotas/integracoes.py` | MikroTik (com `/api/wan/peak`), AdGuard, câmeras (incl. WebSocket do vídeo) |
| `rotas/alertas.py` | Telegram, bot/IA, outros canais, manutenção |
| `rotas/ferramentas.py` | traceroute, IPv4 × IPv6, descoberta, certificados |
| `rotas/autenticacao.py` | login, logout |
| `rotas/paginas.py` | páginas HTML (com a impressão digital dos arquivos), manifesto do PWA e status público |

Cada arquivo de `rotas/` expõe um `router` (`fastapi.APIRouter`, o equivalente aos Blueprints do Flask) e importa só o que usa. A pasta `static/` é montada por último, depois de todas as rotas.

O `main.py` da raiz só importa `app` daqui, para o serviço continuar com `uvicorn main:app`.

**Usa:** todos os módulos. **Usado por:** a interface (`static/`), o Modo TV e scripts.

## Mudanças
- **v4.0** — sai `rotas/multisite.py` (o status público foi para `paginas.py`) e as rotas de SNMP, Zabbix, speedtest, `/api/story`, `/api/diagnoses`, `/api/bandwidth`, `/api/cam/viewers` e `/api/health/workers` (nada as chamava; a página inicial e o bot usam as funções direto). Novas: `/api/wan/peak`; `wan_iface` nas configurações do MikroTik. `/classic` e `/index.html` redirecionam para a interface.
- **v3.14** — `middleware.py`; `/api/audit` com filtros (`user`, `kind`, `hours`, `q`), `/api/audit/users`, `/api/security/secrets`; `/api/me/prefs` (arrumação da página inicial por usuário); `logout` auditado; páginas com `?v=<hash do conteúdo>` gerado na hora (`rotas/paginas.py`).
- **v3.13** — `app.py` (≈1800 linhas, 122 rotas) dividido em 10 roteadores por domínio + `comum.py`. A tabela de rotas (método, caminho, função) foi comparada antes e depois: idêntica.
- **v3.12** — vira `netnoc/web/app.py` (era `main.py`). `/api/topomap` aceita `?at=` (máquina do tempo) com os incidentes e a causa daquele momento; `/api/timemachine`, `/api/bandwidth`; bot com opções de ações e aviso de aparelho novo.
- **v3.11** — `/api/story`, `/api/diagnoses`, `/api/diagnose`, `/api/diary/test`; narrativa dentro de `/api/home`.
- **v3.10** — configuração e teste do bot/IA.
- **v3.5** — `/api/topomap`. **v3.4** — `/api/home`. **v3.3** — interface nova, temas, câmeras, `/api/health/workers`.

## Melhorias desta versão
- Cada domínio num arquivo de 40 a 350 linhas, com imports só do que usa: dá para mexer nas câmeras sem abrir o código do SLA.
- Ponto de entrada separado do código: dá para reorganizar o pacote sem mexer no serviço do Pi, no `install.sh` ou no `reinstalar.sh`.
- O mapa ao vivo e o mapa no passado saem da mesma função (`_topomap`).

## Próximas melhorias
- Testes automáticos de cada roteador com `TestClient` (hoje os testes passam pelo app inteiro).
- Documentação OpenAPI opcional para quem quiser integrar.
