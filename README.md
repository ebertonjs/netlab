# 🛰️ NetLAB

Painel de monitoramento de rede **self-hosted** (na interface ele se chama **NetNOC**; o nome é configurável), feito para rodar num Raspberry Pi (ou qualquer Linux) e ficar aberto num tablet na parede, numa TV ou no PC. Ping, DNS, incidentes, MikroTik, AdGuard, topologia, SLA, câmeras do DVR e modo TV — tudo num processo leve, com SQLite embutido e sem depender de serviço externo.

![Python](https://img.shields.io/badge/Python-3.9%2B-blue)
![FastAPI](https://img.shields.io/badge/FastAPI-backend-009688)
![SQLite](https://img.shields.io/badge/SQLite-embutido-003b57)
![Versão](https://img.shields.io/badge/vers%C3%A3o-3.12-3b82f6)
![Licença](https://img.shields.io/badge/licen%C3%A7a-uso%20gratuito-orange)

![NetLAB — tema Pro escuro](docs/img/pro-escuro.jpg)

---

## ✨ Destaques

- **Ping em tempo real** por destino — latência, jitter e perda, com sparkline e disponibilidade por hora
- Checks **ICMP, TCP e HTTP/HTTPS** (código esperado e validade do certificado) e **multi-site** com agente leve para filiais
- **Incidentes automáticos** que abrem e fecham sozinhos (offline, perda, latência, jitter, DNS lento, CPU/temperatura, câmera sem vídeo, HD do DVR). Queda local vira **um único alerta** em vez de dezenas
- **Notificações** por Telegram, Discord, webhook assinado (HMAC), e-mail e navegador, com janelas de manutenção — no Telegram, a perda de vídeo chega com a **última foto da câmera**
- **6 temas que mudam a interface inteira** (o padrão é o **Pro**, um console de operações escuro/claro), escolhidos por aparelho, com tamanho ajustável (Normal / Compacta / Mínima)
- **Página inicial completa**: indicadores (disponibilidade hoje/7 d/30 d, IP público, último speedtest, tempo sem quedas), disponibilidade de cada destino em blocos de 30 min, portas do MikroTik, aparelhos novos na rede, fotos das câmeras, AdGuard, DNS e saúde do servidor
- **Mapa da rede em caixas**, estilo NOC: grupos de equipamentos ligados por linhas com pacotes animados, causa raiz em vermelho e dependentes como "isolados"
- **Diagnóstico automático da causa**: quando algo cai, o NetNOC investiga sozinho (gateway, internet, DNS, MikroTik/PPPoE/WAN, quedas simultâneas, traceroute) e diz se foi a operadora, energia, um aparelho, o DNS ou a sua rede — com evidências
- **A rede contada**: a página inicial abre com uma frase e a linha do tempo dos episódios com a causa de cada um, e o diário da rede chega todo dia no Telegram
- **Ações pelo Telegram com confirmação**: reiniciar o PPPoE, acordar um PC (Wake-on-LAN), bloquear um aparelho; aviso de aparelho novo na rede e quem está usando a banda agora
- **Máquina do tempo**: arraste a régua do mapa e veja a rede como estava em qualquer momento dos últimos 7 dias
- **Bot no Telegram** com IA opcional (Gemini ou Groq, cota grátis): pergunte "como está o ping pro Google?" e receba o relatório
- **Modo TV** com rodízio de cenas: visão geral, mostradores, mapa da rede, equipamentos, últimas 24 h e câmeras
- **Speedtest automático** diário no horário que você escolher
- **Câmeras do DVR Intelbras** (MHDX, API compatível Dahua) **ao vivo só enquanto alguém assiste** — roda até no Raspberry Pi 3
- **Integrações**: MikroTik (REST), AdGuard Home, SNMP, Zabbix, agentes remotos
- **Comparação de DNS**, speedtest, ferramentas (traceroute, portas, certificados, varredura de rede)
- **SLA**, MTTR/MTBF, heatmap dia × hora, relatório imprimível, página de status pública opcional e métricas **Prometheus**
- **Login com sessão**, perfis admin/visualizador, proteção CSRF e CSP, credenciais cifradas no banco
- **Tudo configurável pela interface**, sem editar arquivo

---

## 🏠 Página inicial

Além dos cards de cada destino, a página inicial mostra tudo o que importa sem precisar clicar. Os blocos de integrações que você não usa (MikroTik, AdGuard, DVR) simplesmente não aparecem.

![Página inicial — blocos de resumo](docs/img/pagina-inicial.jpg)

1. **Indicadores** — disponibilidade hoje / 7 d / 30 d, IP público (e há quanto tempo não muda), último speedtest, tempo sem quedas e incidentes do mês.
2. **Disponibilidade por destino** — 24 h em blocos de 30 min: ok, lento, fora do ar ou isolado.
3. **MikroTik** — cada porta com status e tráfego (o nome vem do comentário da interface) e os **aparelhos na rede**, com os novos do dia em destaque.
4. **Câmeras** — uma foto por minuto, só com a página aberta; clique para ver ao vivo.
5. **AdGuard**, **DNS** e **servidor** (CPU, memória, temperatura, disco), mais o **mapa de incidentes** 7 dias × 24 h na coluna da esquerda.

---

## 🗺️ Mapa da rede

**Topologia → Mapa**: os destinos viram caixas agrupadas, ligadas pelo "Depende de", com pacotes correndo nas linhas e a latência de cada ligação. Quando algo cai, a caixa e a ligação ficam vermelhas e quem depende dela aparece como **isolado** — a causa raiz salta aos olhos.

![Mapa da rede](docs/img/mapa.jpg)

| Com um equipamento fora do ar | No Modo TV |
|---|---|
| ![Mapa com queda](docs/img/mapa-queda.jpg) | ![Mapa no Modo TV](docs/img/tv-topologia.jpg) |

- **Grupos**: defina "Grupo no mapa" em cada destino (Servidores, Wi-Fi, Câmeras…). Sem grupo, o NetLAB agrupa sozinho: destinos de internet em "Internet", locais em "Rede local" e quem tem dependentes ganha caixa própria.
- Caixas extras: **Ambiente** (CPU e temperatura do servidor e do MikroTik) e **Câmeras** (canais do DVR).
- A vista antiga em árvore continua no botão **Árvore**.

---

## 🎨 Temas

Cada aparelho escolhe o seu em **Configurações → Aparência**. O admin define o padrão do servidor, e uma URL pode fixar o tema numa tela de quiosque.

| **Pro** (padrão, escuro / claro) | **Lagoa** |
|---|---|
| ![Pro claro](docs/img/pro-claro.jpg) | ![Lagoa](docs/img/lagoa.jpg) |
| **Glass** | **NOC Terminal** |
| ![Glass](docs/img/glass-escuro.jpg) | ![NOC Terminal](docs/img/terminal.jpg) |
| **Grafana / Zabbix** | **Material You** |
| ![Grafana/Zabbix](docs/img/grafana.jpg) | ![Material You](docs/img/material.jpg) |

- **Pro** — console de operações: menu lateral agrupado, superfícies planas em ardósia, um único azul de destaque e cores só para estado. Números tabulares, IPs em monoespaçada.
- **Lagoa** — estilo painel de casa inteligente: fundo azul-petróleo, cards claros foscos, ícones verde-limão e barra em pílula.
- **Glass** — vidro fosco, cards com imagem e dock flutuante. Feito para tablet na parede.
- **NOC Terminal** — monoespaçado, fósforo verde/âmbar/ciano, destinos em tabela, navegação pelas teclas 1–0.
- **Grafana / Zabbix** — painéis planos e densos com menu lateral fixo. Mais informação por tela no PC.
- **Material You** — paleta inteira gerada a partir da sua cor de destaque.

Ícones do conjunto [Lucide](https://lucide.dev) em todos os temas.

![Configurações → Aparência](docs/img/temas.jpg)

---

## 🔎 Diagnóstico automático

Quando um destino cai ou piora, o NetNOC não manda só "Google offline": em ~15 s ele investiga e manda a causa provável.

```
🔎 Diagnóstico · Google, Cloudflare
Causa provável: Operadora: a conexão PPPoE caiu (confiança alta)
Sua rede está normal (o gateway responde), mas a conexão pppoe-out1 está desconectada.

Evidências:
✅ Gateway 192.168.88.1: responde (0,8 ms, perda 0%)
❌ Internet (Cloudflare 1.1.1.1): sem resposta
✅ MikroTik no ar há 12d 4h · CPU 3%
❌ Conexão pppoe-out1: DESCONECTADA
✅ Porta WAN ether1: com link

O que fazer:
→ Se não voltar em alguns minutos, ligue para a operadora
```

Causas reconhecidas: operadora (PPPoE, ONU sem link, internet fora, instabilidade), falha local, MikroTik reiniciou, falta de energia no servidor, um aparelho só, equipamento do qual outros dependem, parte da rede local, serviço externo, DNS, perda dentro da rede e banda saturada. Funciona sem MikroTik (com menos evidências) e sem IA.

## 🤖 Bot no Telegram

O mesmo bot que manda os alertas também responde. Configure em **Configurações → Alertas → Bot e IA no Telegram** (o token e o Chat ID do Telegram precisam estar preenchidos; o bot só conversa com esse chat).

| Comando | O que faz |
|---|---|
| `/status` | resumo: internet, cada destino e alertas abertos |
| `/ping <destino ou IP> [n]` | ping agora, comparado com as últimas 24 h |
| `/trace <destino ou IP>` | traceroute |
| `/alertas` | incidentes abertos e das últimas 24 h |
| `/mk` | MikroTik: CPU, temperatura e tráfego das portas |
| `/diagnostico [destino]` | investiga a causa agora (rede toda ou um destino) |
| `/diario` | resumo das últimas 24 h com a causa de cada queda |
| `/banda` | quem está usando a internet agora (por aparelho) |
| `/aparelhos` · `/bloqueados` | aparelhos conectados, novos da semana e bloqueados |
| `/pppoe` | reinicia a conexão PPPoE — pede confirmação |
| `/acordar <PC>` | liga o computador pela rede (Wake-on-LAN) — pede confirmação |
| `/bloquear` · `/desbloquear <aparelho>` | corta ou libera o acesso do aparelho — pede confirmação |

**Ações** (reiniciar, acordar, bloquear) vêm desligadas: ative em Configurações → Alertas → Bot → "Permitir ações no roteador". Cada uma chega com os botões **Sim / Cancelar** e só acontece no "Sim". O usuário do MikroTik precisa de permissão de escrita; o bloqueio usa a lista `netnoc-bloqueados` e cria uma regra "NetNOC" no topo do firewall (apague-a para desfazer tudo).

**Com IA** (opcional), dá para perguntar em português: *"a internet caiu essa noite?"*, *"por que o Quad9 está lento?"*, *"faz um traceroute pro 1.1.1.1"*. A IA escolhe as consultas, o NetNOC executa e ela escreve a resposta. Duas opções com cota grátis:

- **Google Gemini** — chave em [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
- **Groq** — chave em [console.groq.com/keys](https://console.groq.com/keys)

A IA só tem acesso a ferramentas de leitura: não altera configuração, não reinicia nada e não roda comandos livres.

## 📺 Modo TV

Tela cheia, pensada para ficar ligada o dia todo: relógio grande, rodízio automático de cenas e alerta em tela cheia quando algo crítico acontece (com som opcional).

| Visão geral | Últimas 24 horas |
|---|---|
| ![Modo TV — visão geral](docs/img/tv-visao-geral.jpg) | ![Modo TV — últimas 24 horas](docs/img/tv-24h.jpg) |

**Mostradores**: um aparelho redondo por destino, no estilo termostato de parede. O anel gira com a latência e brilha em âmbar ou vermelho quando algo degrada ou cai. Só ela, fixa: `/#tv?cenas=6&tempo=0`.

![Modo TV — mostradores](docs/img/tv-mostradores.jpg)

Atalhos: `←` `→` trocam de cena, `espaço` pausa, `A` dispensa o alerta, `S` liga/desliga o som, `F` tela cheia, `Esc` sai.
Para abrir direto numa TV: `http://IP:8000/#tv` — ou só algumas cenas: `/#tv?cenas=1,2,5&tempo=20`.

---

## 📈 Latência, celular e login

![Latência e disponibilidade](docs/img/latencia.jpg)

| Celular | Login |
|---|---|
| <img src="docs/img/celular.jpg" width="280" alt="NetNOC no celular"> | ![Tela de login](docs/img/login.jpg) |

---

## 🦀 Coletor em Rust (opcional)

Para Raspberry Pi mais fraco: o binário **`netnoc-collector`** assume o ping (ICMP nativo, TCP e HTTP), o MikroTik e o AdGuard Home, gravando no mesmo banco. Ele usa poucos MB de RAM e não cria um processo a cada ping. O painel continua igual, e se o coletor parar, o NetNOC volta a coletar sozinho.

Compilação, instalação como serviço e teste antes × depois: [`collector/README.md`](collector/README.md).

---

## 📹 Câmeras (DVR Intelbras)

Integração com DVRs Intelbras da linha **MHDX** (API compatível com Dahua):

- Mosaico e tela cheia **ao vivo**, mais uma cena opcional no Modo TV
- O vídeo **só é puxado do DVR enquanto alguém está assistindo**; ao fechar a tela, o stream para
- O vídeo é repassado sem conversão pelo [go2rtc](https://github.com/AlexxIT/go2rtc) (baixado pelo `install.sh`), por isso roda até no Raspberry Pi 3
- Fotos de cada canal e alertas de **perda de vídeo** e **falha no HD**, com a última imagem no Telegram

Requisitos:
- Streams em **H.264**. Os navegadores não tocam H.265: troque em *Câmera → Codificação* no DVR.
- Um usuário do DVR só de visualização.
- Se o teste mostrar `HTTP 404` nas consultas, habilite o **CGI** nos serviços de rede do DVR. Fotos, nomes e eventos usam o CGI; o vídeo ao vivo usa só o RTSP (porta 554).

O go2rtc escuta apenas em `127.0.0.1`. O navegador nunca fala com o DVR diretamente: tudo passa pelo NetNOC, com login. A senha do DVR não é gravada no arquivo do go2rtc.

---

## 🧰 Requisitos

- Python 3.9 ou superior
- Linux (testado em Raspberry Pi OS e DietPi, inclusive no Raspberry Pi 3)
- Acesso à internet no aparelho (ping, DNS, IP público e speedtest)

---

## 🚀 Instalação

> 📘 **Tutorial completo passo a passo (serviço, HTTPS, backup, problemas comuns): [INSTALL.md](INSTALL.md)**

```bash
git clone https://github.com/ebertonjs/netlab.git
cd netlab
chmod +x install.sh
./install.sh
```

O `install.sh`:
1. instala `gcc`/`python3-dev` se faltar (para compilar o `psutil`), além de `snmp`, `traceroute` e `ping`;
2. baixa o **go2rtc** para a sua arquitetura (câmeras ao vivo);
3. cria o ambiente virtual (`venv`) e instala as dependências.

> Rode **sem** `sudo` — o script pede a senha só quando precisa instalar pacotes.

### Rodando

```bash
source venv/bin/activate
python3 -m uvicorn main:app --host 0.0.0.0 --port 8000
```

Abra `http://IP_DO_DISPOSITIVO:8000` em qualquer aparelho da rede (`hostname -I` mostra o IP do Pi).

Na primeira execução, a senha do usuário **admin** aparece no log. Também dá para defini-la antes com `NETNOC_ADMIN_PASSWORD`, ou trocar depois:

```bash
venv/bin/python manage.py set-password admin
```

### Iniciando no boot (systemd)

Jeito rápido: `./install.sh --service` cria e ativa o serviço. Ou manualmente:

```ini
# /etc/systemd/system/netnoc.service
[Unit]
Description=NetNOC
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/caminho/para/netlab
ExecStart=/caminho/para/netlab/venv/bin/python3 -m uvicorn main:app --host 0.0.0.0 --port 8000
Restart=always
User=seu_usuario

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now netnoc
journalctl -u netnoc -f        # logs
```

---

## ⚙️ Configuração

Tudo pela aba **Configurações**:

- **Destinos** — hosts a monitorar, com dependência (pai) e grupo para o mapa
- **Geral** — intervalos de coleta, speedtest automático e nome do painel
- **Alertas** — limites de latência, jitter, perda e DNS, e Telegram (bot + chat_id, com botão de teste)
- **Integrações** — MikroTik, AdGuard Home e DVR (com **Salvar e testar**, que mostra o que o equipamento respondeu)
- **Aparência** — tema, modo, cor, tamanho da interface e padrão do servidor
- **Backup/restauração** da configuração (as senhas não saem no arquivo)

O `config.json` só é usado na primeira execução para popular o banco; depois tudo fica no SQLite.

### Telegram

1. Crie um bot com o [@BotFather](https://t.me/BotFather) (`/newbot`) e copie o **token**.
2. Mande qualquer mensagem para o bot.
3. Abra `https://api.telegram.org/bot<TOKEN>/getUpdates` e copie o `chat_id`.
4. Cole os dois em **Configurações → Alertas**, ative e clique em **Enviar teste**.

### URLs úteis (quiosque)

| URL | O que faz |
|---|---|
| `/?skin=pro&modo=light` | Tema Pro claro nesta tela |
| `/?skin=terminal&modo=verde#tv` | Modo TV no tema NOC Terminal |
| `/?skin=grafana&modo=dark` | Força o tema Grafana nesta tela |
| `/?skin=material&cor=%230b57d0` | Material You com outra cor |
| `/?densidade=minima` | Interface menor nesta tela |
| `/classic` | Interface antiga (v2) |

### Variáveis de ambiente

| Variável | Para que serve |
|---|---|
| `NETNOC_ADMIN_PASSWORD` | Senha inicial do `admin` |
| `NETNOC_DB` | Caminho do banco de configuração (padrão `netnoc.db`) |
| `NETNOC_HIST_DB` | Caminho do banco de histórico (padrão `netnoc-historico.db`, na mesma pasta) |
| `NETNOC_KEY_FILE` | Arquivo da chave de cifragem (padrão `netnoc.key`) |
| `NETNOC_SECRET_KEY` | Chave de cifragem direto na variável (alternativa ao arquivo) |
| `NETNOC_GO2RTC` | Caminho do go2rtc, se não estiver em `bin/go2rtc` |
| `NETNOC_AUTH=off` | Desliga o login (não recomendado) |

> ⚠️ Faça backup do `netnoc.db` **e** do `netnoc.key`. Sem a chave, as senhas e tokens salvos não podem ser lidos.

### Configuração × histórico

| Arquivo | O que guarda | Pode apagar? |
|---|---|---|
| `netnoc.db` | destinos, grupos, integrações, usuários, aparelhos do DHCP | **Não** — é a sua configuração (alguns KB) |
| `netnoc-historico.db` | pings, médias, DNS, speedtests, incidentes, eventos, logs | **Sim**, quando quiser |

Para zerar o histórico: **Configurações → Geral → Dados → Apagar histórico**, ou com o serviço parado `rm netnoc-historico.db*` (ele é recriado vazio na próxima subida).

### Agente para sites remotos

1. Gere o token em **Configurações → Segurança**.
2. Em cada alvo, informe o site (ex.: `filial-a`).
3. No site remoto (copie `agente/agent.py`): `python3 agent.py --url https://noc.exemplo:8000 --site filial-a --token TOKEN`

### Prometheus

`GET /metrics` com Basic ou `Authorization: Bearer <token>` (o token é gerado na interface).

---

## 🔄 Atualizando

```bash
cd netlab
git pull
./install.sh          # baixa o go2rtc e instala dependências novas
sudo systemctl restart netnoc
```

O banco migra sozinho na primeira subida (faça backup antes). No navegador, `Ctrl+F5` uma vez.

Para uma instalação limpa sem perder nada: `./reinstalar.sh` faz backup da configuração, chave e histórico, remove, instala a versão atual e restaura os dados (detalhes no [INSTALL.md](INSTALL.md#13-reinstalar-ou-desinstalar-com-backup-automático)).

---

## 🗂️ Estrutura

O código fica no pacote `netnoc/`, **um módulo por pasta**, cada uma com um README que explica o que faz, o histórico de mudanças e as próximas melhorias.

```
netlab/
├── main.py                 # ponto de entrada (o serviço continua com: uvicorn main:app)
├── netnoc/
│   ├── nucleo/             # banco (SQLite), segurança e senhas cifradas, estatísticas, backup
│   ├── coleta/             # ping/TCP/HTTP, incidentes, DNS, sistema, MikroTik, AdGuard, SNMP, agentes
│   ├── analise/            # diagnóstico da causa, a rede contada + diário, máquina do tempo, SLA
│   ├── alertas/            # Telegram, Discord, webhook, e-mail, manutenção
│   ├── bot/                # bot do Telegram, IA (Gemini/Groq), ações com confirmação
│   ├── integracoes/        # DVR/câmeras (go2rtc), Zabbix
│   └── web/                # API FastAPI e páginas
├── static/                 # interface (app.html + glass/: temas, Modo TV, mapa, mostradores)
├── collector/              # netnoc-collector em Rust (opcional): ping, MikroTik, AdGuard
├── agente/                 # agente para sites remotos (script independente)
├── manage.py               # utilitário: reset-admin, set-password
├── install.sh · reinstalar.sh · config.json · requirements.txt
├── docs/ · INSTALL.md · CHANGELOG.md
└── LICENSE · THIRD-PARTY-NOTICES.txt
```

| Módulo | Para que serve |
|---|---|
| [`netnoc/nucleo`](netnoc/nucleo/README.md) | onde os dados ficam e quem pode entrar |
| [`netnoc/coleta`](netnoc/coleta/README.md) | mede a rede e decide quando algo virou problema |
| [`netnoc/analise`](netnoc/analise/README.md) | por que caiu, o que aconteceu, como estava |
| [`netnoc/alertas`](netnoc/alertas/README.md) | para onde vão os avisos |
| [`netnoc/bot`](netnoc/bot/README.md) | conversa e age pelo Telegram |
| [`netnoc/integracoes`](netnoc/integracoes/README.md) | câmeras e Zabbix |
| [`netnoc/web`](netnoc/web/README.md) | a API e as páginas |
| [`static`](static/README.md) | a interface |
| [`collector`](collector/README.md) | coletor em Rust |
| [`agente`](agente/README.md) | sites remotos |

## 🛠️ Notas técnicas

- Coletores supervisionados: uma exceção não derruba a thread, e a saúde de cada um aparece em Configurações (`/api/health/workers`)
- Janela de avaliação por tempo (`window_seconds`, padrão 300 s) e DNS lento só depois de 3 medições seguidas
- Histórico bruto de 7 dias, agregados de 5 min/1 h por mais tempo (`history_retention_days`)
- Chart.js, ícones e fontes ficam no próprio projeto: funciona sem internet e sem CDN
- Ping usa o `ping` do sistema, sem precisar de root

---

## 📄 Licença

**Uso gratuito, todos os direitos reservados.** Você pode baixar e usar o NetLAB de graça na sua casa, no trabalho e nas suas redes. Sem autorização por escrito, não é permitido copiar ou reaproveitar o código, redistribuir ou vender o programa, publicar versões modificadas, nem trocar o nome ou o autor. Detalhes em [LICENSE](LICENSE).

O NetLAB usa componentes de código aberto, que mantêm as próprias licenças: veja [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt).
