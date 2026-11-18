# Interface (`static/`)

Tudo que roda no navegador: JavaScript puro, sem build, sem framework e sem CDN (Chart.js, ícones e fontes ficam aqui mesmo, então funciona sem internet).

| Arquivo | O que faz |
|---|---|
| `app.html` | Página principal (interface v3). Carrega os estilos e scripts de `glass/`. |
| `glass/app.js` | Base da interface: helpers (`h`, `api`, `post`…), relógio, menu lateral, atalhos, estado ao vivo (`NN.S`). |
| `glass/home.js` | Página inicial: **a rede contada** (frase de estado, resumo de 24 h, linha do tempo com causa e evidências, "Diagnosticar agora", "Ver o mapa nesse momento"), indicadores, disponibilidade por destino, MikroTik, câmeras, AdGuard, DNS, servidor, mapa de incidentes. |
| `glass/sheets.js` | As telas (Latência, Incidentes, Câmeras, DNS, MikroTik, AdGuard, Topologia com **máquina do tempo**, Ferramentas, SLA, Configurações com Telegram/**Bot e IA**/diário/ações). |
| `glass/topomap.js` | Desenho do mapa em caixas (usado na Topologia e no Modo TV). |
| `glass/tv.js` | **Modo TV**: rodízio de cenas, alerta em tela cheia, som, configuração por URL. |
| `glass/dial.js` · `dial.css` | **Mostradores** (estilo termostato) da cena 6 do Modo TV. |
| `glass/camplayer.js` | Player das câmeras ao vivo (fMP4 pelo WebSocket do go2rtc). |
| `glass/skins.js` · `skins/*.css` | Temas: **Pro** (padrão), Glass, NOC Terminal, Grafana, Material You, Lagoa; escuro/claro e tamanho da interface. |
| `glass/ui-icons.js` | Ícones Lucide embutidos. `icons.js`: ícones de marcas (Simple Icons). |
| `glass/glass.css` | Estilos base de todas as telas. |
| `login.html` · `login.js` | Tela de login. |
| `status.html` · `report.html` | Status público e relatório de SLA para imprimir. |
| `index.html` · `js/` · `*.css` | Interface clássica (`/classic`), mantida por compatibilidade. |
| `sw.js` · `manifest.webmanifest` · `icon-*.png` | PWA (instalar como app; cache do "casco" para abrir offline). |

Cada arquivo é carregado com `?v=<versão>` em `app.html`, e o `sw.js` troca o nome do cache a cada versão, então o navegador sempre pega o código novo.

## Mudanças
- **v3.12** — máquina do tempo na Topologia → Mapa (régua com as quedas, arrastar, voltar/avançar, reproduzir, Ao vivo); "Ver o mapa nesse momento" na linha do tempo; opções de ações e aviso de aparelho novo no bot.
- **v3.11** — painel "a rede contada" no topo da página inicial; diário e "Ver diário agora" no bot.
- **v3.10** — cena Mostradores no Modo TV; tela do bot/IA com teste de pergunta.
- **v3.8** — tema Pro (padrão), ícones Lucide, nova marca e login. **v3.7** — tema Lagoa. **v3.5** — mapa em caixas. **v3.4** — página inicial completa. **v3.3** — interface nova, temas, câmeras, Modo TV refeito.

## Melhorias desta versão
- O mapa ao vivo e o do passado usam o mesmo desenho; no passado a régua fica destacada e os textos mudam para "naquele momento".

## Próximas melhorias
- Separar `sheets.js` (≈1300 linhas) em um arquivo por tela.
- Página inicial em modo "calmo" (quase vazia quando tudo está bem), como na proposta original.
