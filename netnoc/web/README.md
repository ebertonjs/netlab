# Web (`netnoc/web`)

A API e as páginas. Não coleta nem decide nada: junta o que os outros módulos produzem e entrega para a interface, o Modo TV, o bot e as integrações.

| Arquivo | O que faz |
|---|---|
| `app.py` | Só a montagem: cria o FastAPI, liga o middleware de segurança, inclui as rotas e, na partida, liga a coleta, o diagnóstico, o diário, o bot e as câmeras. |
| `comum.py` | O que as rotas compartilham: versão, configuração, auditoria (`audit`), períodos (`secs`), permissão (`need_admin`). |
| `rotas/sistema.py` | saúde, `/api/me`, versão e sistema, usuários, auditoria, backup/restauração, Prometheus (`/metrics`), dados do histórico, intervalos, nome, tema, speedtest automático (23 rotas) |
| `rotas/metricas.py` | visão geral, histórico de latência/perda, destinos, DNS, incidentes, eventos, SLA, tempo real (SSE) (20) |
| `rotas/painel.py` | página inicial com a narrativa, diagnóstico sob demanda, diário, mapa e máquina do tempo (7) |
| `rotas/destinos.py` | cadastro de destinos e DNS, aparelhos do DHCP (7) |
| `rotas/integracoes.py` | MikroTik, AdGuard, SNMP, Zabbix, câmeras (incl. WebSocket do vídeo), banda por aparelho (31) |
| `rotas/alertas.py` | Telegram, bot/IA, outros canais, manutenção (12) |
| `rotas/ferramentas.py` | traceroute, IPv4 × IPv6, descoberta, certificados, speedtest (6) |
| `rotas/multisite.py` | agentes remotos e status público (7) |
| `rotas/autenticacao.py` | login, logout (4) |
| `rotas/paginas.py` | páginas HTML e manifesto do PWA (5) |

Cada arquivo de `rotas/` expõe um `router` (`fastapi.APIRouter`, o equivalente aos Blueprints do Flask) e importa só o que usa. A pasta `static/` é montada por último, depois de todas as rotas.

O `main.py` da raiz só importa `app` daqui, para o serviço continuar com `uvicorn main:app`.

**Usa:** todos os módulos. **Usado por:** a interface (`static/`), o Modo TV, scripts e agentes.

## Mudanças
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
