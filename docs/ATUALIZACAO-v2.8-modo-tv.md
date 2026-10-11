# v2.8 — Modo TV novo
Abra pelo botão 📺 (ou `http://SEU-IP:8000/#tv`). O visual segue o tema escolhido (no Tema Grafana fica claro, com blocos coloridos).

## Cenas (rodízio automático, padrão 15 s)
1. Visão geral: anel de saúde, radar, internet/IP/latência/perda, incidentes ativos e resolvidos.
2. Topologia: árvore em tela cheia com offline/isolados em destaque.
3. Equipamentos: Raspberry Pi, MikroTik (foto com portas + tráfego WAN), AdGuard (top bloqueados) e Zabbix (se ativo).
4. Últimas 24 h: latência 24 h, speedtest, SLA do mês (meta 99,9%), sites remotos e certificados.

## Modo alerta
Incidente de severidade Alta toma a tela (nome, cronômetro, impacto/isolados, uptime), pausa o rodízio e volta sozinho ao resolver. Incidentes menores e queda de porta aparecem como faixa no topo.

## Teclas
← → trocar cena · 1-4 ir direto · espaço pausa · A dispensa o alerta · S som · F tela cheia · Esc sai (ou fecha o menu ⚙).
Mexa o mouse para mostrar os botões (inclui ⚙ para escolher cenas e o tempo).

## URL
`#tv?cenas=1,2,3&tempo=20&som=1` (cenas, segundos por cena, som ligado).

Arquivos: static/js/wall.js (reescrito), static/tv.css (novo), static/index.html, static/sw.js. Sem mudança no backend.
Copie por cima e dê Ctrl+F5.
