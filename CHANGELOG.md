# Histórico de versões

## v3.5 — mapa da rede em caixas
- **Topologia → Mapa**: destinos agrupados em caixas (Internet, Rede local, equipamentos com dependentes ou o grupo que você definir), ligadas pelo "Depende de", com pacotes animados nas ligações, latência e estado de cada item. Caixas extras: **Ambiente** (CPU/temperatura do servidor e do MikroTik) e **Câmeras**. A vista antiga continua em **Árvore**.
- Indicadores (online, fora, avisos, isolados), anel de status e problemas atuais no painel lateral.
- **Modo TV**: a cena Topologia usa o mesmo mapa.
- Novo campo **Grupo no mapa** em cada destino (card do destino e cadastro); entra no backup. Novo endpoint `/api/topomap`.

## v3.4 — página inicial com mais informação
- **Indicadores**: disponibilidade hoje / 7 d / 30 d, IP público (e há quanto tempo não muda), último speedtest, tempo sem quedas e incidentes do mês com tempo médio de solução.
- **Disponibilidade por destino**: 24 h em blocos de 30 min (ok, lento, fora, isolado pelo pai), com detalhes ao passar o mouse.
- **MikroTik**: portas com status, tráfego e comentário de cada interface; **aparelhos na rede** (DHCP) com os novos do dia em destaque.
- **Câmeras** na página inicial (uma foto por minuto, clique abre ao vivo). DVR sem o CGI de foto: a foto passa a ser tirada do próprio vídeo pelo go2rtc.
- **AdGuard**, **DNS** e **servidor** (CPU, memória, temperatura, disco) em blocos próprios; **mapa de incidentes** 7 dias × 24 h na coluna da esquerda.
- **Speedtest automático** diário (padrão 04:30), em Configurações → Geral; entra no backup.
- Blocos de integrações não configuradas não aparecem. Novo endpoint `/api/home`.

## v3.3 — câmeras, temas e interface nova
- **Interface nova** (`/`): relógio, chips de status, cards por destino com sparkline, dock e painéis de Latência, Incidentes, Câmeras, DNS, MikroTik, AdGuard, Topologia, Ferramentas, SLA e Configurações. A interface anterior continua em `/classic`.
- **4 temas que mudam a interface inteira**: Glass (escuro/claro), NOC Terminal (verde/âmbar/ciano), Grafana/Zabbix e Material You (paleta gerada pela cor de destaque). Escolha por aparelho, padrão definido pelo admin e URL de quiosque (`?skin=&modo=&cor=`).
- **Tamanho da interface** (Normal / Compacta / Mínima), por aparelho; compacta por padrão.
- **Modo TV refeito** para o novo visual: 5 cenas (visão geral, topologia animada, equipamentos, 24 h e câmeras), alerta em tela cheia, som e rodízio configurável.
- **Câmeras do DVR Intelbras** (MHDX, API compatível Dahua): mosaico e tela cheia ao vivo **só enquanto alguém assiste** (go2rtc, sem converter vídeo), fotos, alertas de perda de vídeo e falha no HD com a última imagem no Telegram. O teste do DVR mostra o que o firmware respondeu.
- **Coletores supervisionados**: uma exceção não derruba a thread; saúde de cada coletor em Configurações (`/api/health/workers`). Intervalos aplicados na hora.
- **Incidentes mais precisos**: janela de avaliação por tempo (`window_seconds`), sem alerta de perda logo após o offline, queda local vira um único alerta, DNS lento só após 3 medições seguidas.
- **Segurança**: limite de tentativas por IP + usuário (sessão válida nunca é bloqueada), WebSocket das câmeras com sessão e checagem de origem, CSP atualizada.
- Fontes servidas localmente; erros do Telegram mostram o motivo real sem expor o token.

## v3.0 — versão final
- **Tela de login própria** com nome do app e tema; sessão por cookie assinado; botão Sair; sessão expirada volta ao login.
- Tutorial de instalação (`INSTALL.md`), `install.sh --service` e exemplo de serviço systemd.

## v2.9 — correções
- Temas aplicados em tudo (Mission Control e Modo TV seguem o tema, tom claro/escuro automático).
- Alertas do Telegram agora salvam ao trocar o Chat ID; a tela mostra erros reais.
- Nome da aplicação propagado: TV, título, notificações, alertas, relatório SLA, status público, manifesto PWA.

## v2.8 — Modo TV novo (4 cenas, tela de alerta, som, configuração por URL)
## v2.7 — Topologia em árvore (Hierarquia) + Grafo livre
## v2.6 — Tema Grafana
## v2.5 — Menu lateral recolhível e responsivo
## v2.4 — Mission Control: latência 24h, speedtest, sites, AdGuard top
## v2.0–2.3 — Blocos 1–3 (checks TCP/HTTP, SNMP, Zabbix, multi-site, notificações, SLA, backup), Mission Control e Modo TV

Detalhes de cada atualização em `docs/`.
