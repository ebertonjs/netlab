# v2.4 — Mission Control: novos cards

Nova faixa entre o hardware e a lista de alvos. Cada card só aparece se tiver dado.

- **Latência da internet · 24 h**: gráfico, mín/média/máx e o último speedtest com barras dos últimos 8 testes.
- **Sites remotos**: status de cada agente (online / mudo há X) e o diagnóstico "problema no alvo / no caminho do site". Some se não houver agente.
- **Top consumidores**: interfaces do MikroTik por tráfego e, no AdGuard, clientes mais ativos e domínios mais bloqueados.

Arquivos: main.py (novo GET /api/agh/top), monitor.py (get_agh_top), static/js/mission.js, static/mission.css, static/index.html, static/sw.js.
Depois de copiar: reinicie o serviço e dê Ctrl+F5 (o service worker troca de cache sozinho).
