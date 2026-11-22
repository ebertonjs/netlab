# Interface (`static/`)

Tudo que roda no navegador: JavaScript puro, sem build, sem framework e sem CDN (Chart.js, ícones e fontes ficam aqui mesmo, então funciona sem internet).

| Arquivo | O que faz |
|---|---|
| `app.html` | A interface. Carrega os estilos e scripts de `glass/` (cada um com `?v=` gerado pelo servidor). |
| `glass/app.js` | Base da interface: helpers (`h`, `api`, `post`…), menu lateral, atalhos, estado ao vivo (`NN.S`), cards dos destinos agrupados, rede de segurança contra erros. |
| `glass/home.js` | Página inicial: estado e causa, 4 números ao vivo, linha do tempo, blocos de detalhes (reordenar/recolher/esconder, salvo por usuário). |
| `glass/telas/*.js` | (v4.4, antes `sheets.js`) Uma tela por arquivo: `comum.js` (botões, campos, seções, gráficos, em `window.NNT`) e `latencia`, `destino`, `incidentes`, `dns`, `mikrotik`, `adguard`, `topologia`, `ferramentas`, `sla`, `cameras`, `config`. As telas (Latência, Incidentes, Câmeras, DNS, MikroTik, AdGuard, Topologia com **máquina do tempo**, Ferramentas, SLA, Configurações com Telegram/**Bot e IA**/diário/ações). |
| `glass/topomap.js` | Desenho do mapa em caixas (usado na Topologia e no Modo TV). |
| `glass/tv.js` | **Modo TV**: rodízio de cenas, alerta em tela cheia, som, configuração por URL. |
| `glass/dial.js` · `dial.css` | **Mostradores** (estilo termostato) da cena 6 do Modo TV. |
| `glass/camplayer.js` | Player das câmeras ao vivo (fMP4 pelo WebSocket do go2rtc). |
| `glass/skins.js` · `skins/pro.css` | Tema **Pro**: escuro, claro ou automático (escuro das 18h às 7h) e tamanho da interface. |
| `glass/ui-icons.js` | Ícones Lucide embutidos. `icons.js`: ícones de marcas (Simple Icons). |
| `glass/glass.css` | Estilos base de todas as telas. |
| `login.html` · `login.js` | Tela de login. |
| `status.html` · `report.html` | Status público e relatório de SLA para imprimir. |
| `sw.js` · `manifest.webmanifest` · `icon-*.png` | PWA (instalar como app; cache do "casco" para abrir offline). |

Na hora de entregar `app.html` e `index.html`, o servidor troca o `?v=` de cada arquivo pela impressão do conteúdo (v3.14): o navegador guarda os arquivos por um ano e só baixa o que mudou, e o `sw.js` os serve direto do cache.

## Mudanças
- **v4.0** — saem a interface clássica (`index.html`, `js/`, 7 CSS), os temas Glass, NOC Terminal, Grafana, Material You e Lagoa (≈14 KB de CSS a menos) e a página inicial antiga. Notificações Discord/webhook/e-mail, usuários, backup/restauração e token do Prometheus passaram para Configurações. Modo automático do tema. Pico da WAN no lugar do speedtest (Ferramentas, MikroTik na página inicial e cena 3 da TV). Porta da WAN nas configurações do MikroTik. Login sem depender do CSS antigo.
- **v3.14** — **página inicial nova** (estado + causa + 4 números no topo, linha do tempo só com problema, destinos agrupados com problema primeiro, blocos reordenáveis/recolhíveis salvos por usuário; a clássica continua em Aparência); Configurações → Segurança (senhas e tokens salvos, auditoria com filtros); rede de segurança contra erros (`NN.safe`, aviso por bloco, TV não para numa cena quebrada); service worker com cache primeiro para arquivos versionados.
- **v3.12** — máquina do tempo na Topologia → Mapa (régua com as quedas, arrastar, voltar/avançar, reproduzir, Ao vivo); "Ver o mapa nesse momento" na linha do tempo; opções de ações e aviso de aparelho novo no bot.
- **v3.11** — painel "a rede contada" no topo da página inicial; diário e "Ver diário agora" no bot.
- **v3.10** — cena Mostradores no Modo TV; tela do bot/IA com teste de pergunta.
- **v3.8** — tema Pro (padrão), ícones Lucide, nova marca e login. **v3.7** — tema Lagoa. **v3.5** — mapa em caixas. **v3.4** — página inicial completa. **v3.3** — interface nova, temas, câmeras, Modo TV refeito.

## Melhorias desta versão
- O mapa ao vivo e o do passado usam o mesmo desenho; no passado a régua fica destacada e os textos mudam para "naquele momento".

## Próximas melhorias
