# NetNOC v2.3 — Mission Control como painel principal

Copie por cima (mantendo as pastas) e dê Ctrl+F5. Sem mudança no banco; não precisa reiniciar o serviço.
Alterados: static/js/mission.js, static/mission.css

- Faixa de KPIs: status da internet (+ último speedtest), IP público (v4/v6), latência média (+ jitter) e perda de pacotes.
- Hardware: Raspberry Pi (CPU/memória/temperatura), MikroTik (foto com portas ao vivo, tráfego WAN, CPU/mem/temp, uptime) e AdGuard Home (consultas, bloqueadas, % de bloqueio, gráfico da última hora, proteção, tempo de resposta). Cada card só aparece se a integração estiver ativa.
- Alvos: "Precisam de atenção" (cards grandes, só offline/degradados) e "Operando normalmente" (lista compacta com sparkline e barra de 24 h).
- Anel de saúde: sub-notas Internet, Disp. 24h e Equip. (pior entre MikroTik e Raspberry Pi).
- Cabeçalho enxuto e faixa vermelha global escondida nesta página.
- **Visão Geral desativada (teste)**: some do menu e redireciona para o Mission Control. Para reativar: em static/js/mission.js troque `const HIDE_OVERVIEW = true;` por `false`.
