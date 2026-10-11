# v2.7 — Topologia em árvore (hierarquia)
Nova aba **Hierarquia** (padrão) na Topologia; o grafo antigo continua em **Grafo livre**.
- Níveis montados pelo campo "pai" dos destinos (Configurações → Rede). Quem não tem pai fica ligado direto à Internet.
- Cards com ícone (deduzido pelo nome), IP, latência e sparkline; cor da base = estado.
- Offline com um equipamento acima também offline vira "ISOLADO POR X" (cinza, tracejado).
- Espessura do link da Internet = tráfego da WAN do MikroTik (se integrado).
- Clique no card: painel com status, há quanto tempo, latência, perda, uptime 24 h, impacto, filhos, incidentes e gráfico 24 h.
- Botão − / número no card recolhe/expande ramos (lembra a escolha); busca por nome ou IP (Enter vai ao primeiro); zoom, ajustar e expandir tudo.
Arquivos: static/js/tree.js (novo), static/tree.css (novo), static/index.html, static/sw.js, static/js/layout.js (subtítulo). Sem mudança no backend.
Copie por cima e dê Ctrl+F5.
