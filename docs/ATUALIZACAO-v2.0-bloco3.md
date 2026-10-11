# NetNOC v2.0 — Bloco 3 (visual / frontend)

## IMPORTANTE
- **APAGUE `static/app.js`** — foi dividido em `static/js/*.js`.
- `static/style.css` não mudou; o novo CSS está em `static/extra.css`.
- Copie os arquivos mantendo as pastas (`static/js/`).

## Arquivos
- Backend: `main.py`, `stats.py` (heatmap, disponibilidade diária, /status público)
- `static/index.html`, `util.js`, `topology.js`, `extra.css`
- `static/js/`: layout, core, settings, mikrotik, agh, ui, live, charts-extra, analysis, tools, settings-extra, wall, pwa
- Página pública: `status.html`, `status.js` (rota `/status`, ative em Configurações → Segurança)
- Relatório imprimível SLA: `report.html`, `report.js`
- PWA: `sw.js`, `manifest.webmanifest`, `icon-192.png`, `icon-512.png`

## Novidades
- Ao vivo via SSE (chip "ao vivo"), notificações do navegador (🔔)
- Sparklines + ▲/▼ na tabela de alvos; skeletons e estados vazios
- Gráficos: faixas de incidente, zoom por arraste, pico anotado, badge de SLA
- Página Análise: timeline (Gantt), heatmap dia×hora, Zabbix, sites, certificados
- Página Ferramentas: traceroute, IPv4×IPv6, descoberta (+Monitorar), SLA/CSV/relatório
- Config: abas Notificações/manutenção, SNMP, Zabbix, Segurança (usuários, tokens, backup, status público, auditoria)
- Modo TV (📺 ou `#tv`), topologia com cor/espessura por qualidade e partículas de tráfego
- Mobile: sidebar empilhada, alvos de toque 44px; tema claro com contraste ajustado; impressão

## Limitações
- Sem agrupamento da topologia por site
- Sem Web Push real: notificações só com a página/SW ativos
- Zoom próprio (sem chartjs-plugin-zoom)
- Não testado: banco real grande e envios reais Telegram/Discord/SMTP
- OIDs de potência óptica de OLT devem ser informados por você
