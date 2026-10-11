# NetNOC v2.2 — Mission Control

Copie por cima (mantendo as pastas). Não precisa mexer no banco; dê Ctrl+F5 no navegador.

Novos: static/mission.css, static/js/mission.js
Alterados: static/index.html, static/sw.js, static/js/wall.js

- Nova página **Mission Control** no menu (logo abaixo de Visão Geral). Na primeira abertura após atualizar ela vira a página inicial; depois o NetNOC lembra a última página usada.
- Anel de saúde (0–100) = 30% disponibilidade 24 h + 30% estado dos alvos + 15% latência + 25% incidentes ativos. Sub-notas: Internet, Alvos e Equipamento (MikroTik).
- Radar de latência (anéis 5/20/50/100 ms), incidentes ativos com cronômetro, resolvidos de hoje, linha de 24 h, foto do MikroTik com portas ao vivo e cards por alvo.
- Respeita "reduzir movimento" do sistema (sem animações).
- Os botões "Auto-organizar / Restaurar" agora só aparecem na Visão Geral.
- Modo TV: não repete mais o nome do alvo na mensagem do incidente.
