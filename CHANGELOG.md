# Histórico de versões

## v4.4 — código mais fácil de manter
Nada muda na tela nem no uso; é a arrumação que deixa as próximas versões mais seguras.
- **FastAPI 0.135 e Starlette 1.x** (antes 0.111 e 0.37). O pydantic fica como está: no Raspberry Pi 3 a versão nova dependeria de um pacote compilado em Rust que pode não existir pronto para o Pi.
- **`atualizar.sh` volta as dependências também**: guarda a lista do `pip freeze` antes de instalar e, se a atualização falhar, reinstala as versões de antes.
- **`monitor.py` (1.500 linhas) em 10 módulos** por assunto, **`aibot.py` em 5** e **`sheets.js` em um arquivo por tela** (`static/glass/telas/`). `monitor` e `aibot` continuam existindo como fachada.
- **Migrações do banco numeradas** (`PRAGMA user_version` em cada arquivo): rodam só as pendentes, cada uma na sua transação; `manage.py migracoes` mostra a versão.
- **Testes novos**: o NetNOC sobe de verdade e nenhuma rota dá erro 5xx (`partida`); um Chromium abre todas as telas e falha em qualquer erro de JavaScript (`test_navegador.py`, roda no CI); migrações.

## v4.3 — medição e dados
- **Medir agora**: a velocidade real da internet lida no MikroTik a cada segundo (30 s a 2 min) enquanto você roda um speedtest no celular ou no PC. Mostra o pico e a média dos 3 melhores segundos, comparando com o plano contratado (novo campo na tela do MikroTik). Na tela do MikroTik, pelo Telegram (`/medir`) ou pedindo à IA ("testa a velocidade"). Usa o `monitor-traffic` do RouterOS; se ele não estiver disponível pela REST, usa os contadores. Não precisa de device-mode.
- **Syslog do MikroTik**: o roteador manda o log dele para o NetNOC (UDP 5514, só aceita o IP do MikroTik). Cada queda do PPPoE vira um evento com o motivo traduzido ("a operadora parou de responder", "falha de autenticação"…), o diagnóstico de queda da operadora cita a linha do log, e há uma tela de log com filtro e busca. Telegram: `/log`, `/log pppoe`, `/log admin`. Comandos do RouterOS prontos em Configurações → Integrações.
- **Tráfego das portas em médias de 5 min**: o bruto fica 2 dias (`iface_raw_retention_days` no config.json) e o resto vira média e pico de 5 min. A tabela que passava de 1 milhão de linhas em 30 dias fica com ~3% disso. Gráficos de semana e o pico de 7/30 dias leem o agregado; o pico não se perde. A primeira limpeza roda em lotes, sem travar o Pi.
- "PPOE OPERADORA" e nomes parecidos agora são reconhecidos como a porta da internet.

## v4.2 — rede de segurança
- **Backup diário no Telegram**: `.tar.gz` com a configuração, usuários e senhas cifradas, no horário escolhido (Configurações → Geral). Histórico opcional. `/backup` manda na hora; `/saude` mostra o estado. A chave `netnoc.key` nunca vai junto.
- **Restaurar pelo terminal**: `manage.py restaurar arquivo.tar.gz --yes` guarda os arquivos atuais e avisa se a chave não abre as senhas do backup. `manage.py backup` gera o arquivo na pasta.
- **`/healthz` de verdade**: responde 503 quando o banco não responde ou um laço de coleta parou (antes, sempre 200).
- **Watchdog** (`./install.sh --watchdog`): timer do systemd que reinicia o NetNOC depois de 3 falhas seguidas do `/healthz`. Cobre o caso "travado mas não caiu", que o `Restart=always` não pega.
- **Vigia externo**: a cada minuto o NetNOC avisa uma URL do healthchecks.io (ou compatível); se o Pi parar, o serviço avisa você. A URL fica cifrada.
- **MikroTik por HTTPS com certificado fixado**: botão "Ler certificado" na tela do MikroTik, comandos do RouterOS prontos (certificado próprio, `www-ssl` só para o Pi, usuário com o mínimo de permissões). O NetNOC e o coletor Rust (4.1.0) só aceitam aquele certificado; se mudar, param e avisam.
- **`atualizar.sh`**: aplica o zip de atualização, apaga os arquivos que saíram (`REMOVER.txt`), confere o `/healthz` e volta sozinho para a versão anterior se falhar. `--desfazer` volta a última.
- **Testes no repositório** (`tests/`, `pytest -q`) e **CI a cada push** (Python 3.11 e 3.13, sintaxe dos `.js`, `cargo clippy` e `cargo test`).
- Volta automática de porta: se o agendador do MikroTik recusar por permissão (usuário restrito), o NetNOC agenda a volta ele mesmo, como já fazia com o device-mode.

## v4.1 — pedir em português: "reinicia tudo", "desliga o PPPoE", "manda as câmeras"
- **Fotos das câmeras na hora** pelo Telegram: `/cameras` (todas, num álbum) ou `/cameras portão`; com IA, "me manda a foto da garagem".
- **Desligar e ligar portas do MikroTik** (`/desligar`, `/religar`, `/portas`; com IA, "desabilita a porta do roteador"). A porta é achada pelo nome ou pelo **comentário** dela no RouterOS. "pppoe" desliga a conexão de internet.
  - **Volta automática agendada no próprio MikroTik** (scheduler do RouterOS, padrão 5 min, ajustável): religa mesmo se o Pi ficar sem internet. A internet nunca fica desligada sem ela. Religar antes cancela o agendamento.
  - Nunca desliga a porta em que o servidor do NetNOC está ligado (descoberta pela tabela ARP/bridge) nem a bridge.
- **Reinícios** (`/reiniciar mikrotik | dvr | servidor | netnoc | tudo`; com IA, "reinicia tudo"): uma confirmação só, na ordem segura (DVR → NetNOC → MikroTik → servidor por último). O bot avisa quando o MikroTik volta (com o estado do PPPoE) e quando o servidor/NetNOC sobe de novo. O que entra no "tudo" é escolhido nas configurações (padrão: MikroTik e DVR).
- Servidor e NetNOC precisam de uma permissão única no Pi: `./install.sh --permitir-reinicio` (só `systemctl reboot` e `systemctl restart netnoc`; desfaz com `--remover-reinicio`).
- Tudo continua com os botões **Sim / Cancelar**, auditado, e com chaves próprias em Configurações → Alertas → Bot e IA ("Permitir desligar e ligar portas", "Permitir reinícios").

## v4.0 — enxuto: só o que se usa, bem feito
O NetNOC foi reformulado para o que um NOC doméstico/pequeno usa de verdade. Menos código para manter, menos coisa rodando no Pi e uma interface só.

**O que saiu**
- **Interface clássica** (`/classic`, ≈6.000 linhas de HTML/JS/CSS). As configurações que só existiam nela foram para a interface: **outros canais de alerta** (Discord, webhook assinado, e-mail) em Alertas, **usuários** e **token do Prometheus** em Segurança, **backup/restauração** em Geral. `/classic` agora abre a interface.
- **Temas** Glass, NOC Terminal, Grafana/Zabbix, Material You e Lagoa. Fica o **Pro**, com modo escuro, claro ou **automático** (escuro das 18h às 7h, troca sozinho). Quem usava outro tema passa para o Pro mantendo claro/escuro.
- **Página inicial clássica** (coluna com relógio, chips de status): a página nova é a única.
- **SNMP, Zabbix e multi-site** (agentes remotos, pasta `agente/`).
- **Speedtest** (manual e automático): no Raspberry Pi 3 a placa de rede vai até 100 Mbps (no 3 B+, ~300), então o teste media o Pi, não a internet, e ainda gastava banda todo dia.
- Rotas da API que nada chamava, notas de atualização antigas em `docs/` e imagens sem uso.

**O que entrou no lugar**
- **Velocidade real da internet**: o maior download/upload que passou pela **porta WAN do MikroTik** hoje, em 7 e em 30 dias — na página inicial (bloco do MikroTik), em Ferramentas, na cena 3 do Modo TV, no diário e no bot (`banda_wan`). A porta é descoberta sozinha (PPPoE primeiro, ou nome/comentário de WAN) ou escolhida em Configurações → Integrações → MikroTik → **Porta da internet**.
- **Internet saturada** no diagnóstico passa a comparar o tráfego atual com o maior dos últimos 30 dias.

**Mais leve**
- Interfaces do MikroTik (a maior tabela do histórico): porta parada ou desligada só é gravada quando muda de estado ou a cada 10 min, no Python e no coletor Rust (4.0.0). Na primeira hora após a atualização, as linhas antigas dessas portas e os pings de agentes são apagados em lotes.
- Coletores sem nada configurado (MikroTik/AdGuard desligados, certificados sem destino HTTPS, câmeras sem DVR) saem da lista de saúde e nunca viram aviso de "coleta com falha".
- Tela de login sem depender do CSS antigo.

**Atualização (automática na primeira subida)**
- A migração apaga do banco as tabelas e configurações do que saiu e tira os destinos do tipo agente; o resto fica igual. Backups da v3 restauram normalmente (o que saiu é ignorado).
- O coletor Rust 4.0.0 sai pela release do GitHub como antes; o 3.13 continua funcionando com a v4.0.

**Correções**
- Gráficos e mini-gráficos davam erro quando um destino não tinha jitter registrado.

## v3.14 — segurança em repouso, auditoria completa e interface que não quebra
**Segredos (`netnoc/nucleo/cofre.py`)**
- Inventário de **todas** as senhas e tokens salvos (Telegram, MikroTik, AdGuard, Gemini/Groq, Zabbix, câmeras, Discord/webhook/e-mail, SNMP e a assinatura das sessões), com o estado de cada um — cifrado, vazio ou em texto puro — sem nunca mostrar o valor. Em Configurações → **Segurança** e em `python manage.py secrets`.
- Na partida, o NetNOC **cifra o que tiver ficado em texto puro** (bancos antigos, restauração manual) e **corrige a permissão do `netnoc.key`** para 0600. A chave que assina os cookies de sessão também passou a ficar cifrada no banco.
- **Troca da chave**: `python manage.py rotate-key --yes` (com o NetNOC e o coletor parados) gera uma chave nova e recifra tudo numa transação só; se qualquer valor não decifrar, nada muda. A chave anterior fica em `netnoc.key.<data>.bak` (0600).

**Auditoria**
- Toda alteração pela API (POST/PUT/PATCH/DELETE) entra no registro com usuário, IP, caminho e resultado — inclusive as que ainda não tinham registro próprio, sem duplicar as que já tinham. **Tentativas negadas** (403, ex.: visualizador tentando apagar um usuário), erros 500, saídas (`logout`), entradas e senhas erradas.
- Tela nova em Configurações → **Segurança**: filtros por usuário, tipo (entradas/saídas, negado/falhas, alterações), período e busca. Na linha de comando: `python manage.py audit 50`.

**Página inicial nova**
- Em cima, **o estado da rede e a causa** ("Facebook fora do ar há 7 min · Causa provável: DNS fora", com Diagnosticar, Ver no mapa e Incidentes) e **4 números**: disponível hoje, latência e perda agora (ao vivo) e incidentes. Substituem os chips, a coluna do relógio e a fileira de indicadores; o problema aparece uma vez só.
- **Linha do tempo** aberta só quando há problema; com tudo bem vira uma linha ("Últimas 24 h: …") com "Abrir linha do tempo".
- **Destinos** agrupados em Internet e Rede local, **com problema primeiro**.
- **Detalhes em blocos** (disponibilidade, MikroTik, DNS, AdGuard, servidor, câmeras, mapa de incidentes): arraste ⋮⋮ para reordenar, clique no título para recolher, "Personalizar" para esconder ou restaurar o padrão. A arrumação fica **salva por usuário no servidor**, igual em qualquer aparelho (o perfil visualizador também pode arrumar a dele).
- Falhas da própria coleta (AdGuard, MikroTik…) viram um aviso discreto no topo.
- Funciona nos 6 temas e no celular. Quem preferir a antiga: Configurações → Aparência → Página inicial → **Clássica**.

**Interface**
- Medido com o navegador por 4 a 6 min (Modo TV girando as cenas, página inicial ao vivo e as telas abrindo/fechando 120 vezes): memória, elementos e ouvintes **estáveis**, todos os gráficos destruídos ao fechar. Sem vazamento.
- Rede de segurança contra erros: um bloco que falha (gráfico, mapa, indicador, cena da TV) vira um aviso **no lugar dele** e o resto continua. O rodízio da TV não para numa cena quebrada (interface nova e clássica). Erros soltos vão para o console e, no máximo a cada 30 s, para um aviso na tela.
- **Enlaces lentos (rádio, satélite, 4G)**: as respostas de texto saem comprimidas (gzip, cerca de 70% menores; arquivos comprimidos uma vez e guardados) e cada arquivo da página leva `?v=<impressão do conteúdo>` gerado sozinho, o que permite ao navegador guardá-lo por um ano e só baixar de novo o que mudou. O app instalado (PWA) abre esses arquivos direto do cache. O tempo real (SSE) e o vídeo ficam fora da compressão.

**Banco**
- Índices novos para o DNS, os agregados de 5 min e 1 h, as interfaces do MikroTik e a auditoria; `PRAGMA optimize` na partida e na limpeza diária; caches curtos nas consultas mais pesadas (barras de disponibilidade, mini-gráficos, SLA, narrativa). Num banco grande (600 mil pings, 1,4 milhão de leituras do MikroTik) as telas que levavam 50–95 ms passaram para 2–15 ms; MikroTik → interfaces de ~80 ms para 3–6 ms.

## v3.13 — base mais robusta (coletor e API)
**Coletor em Rust (`collector/`)**
- **Backoff exponencial** no MikroTik e no AdGuard: quando o equipamento não responde, as tentativas se espaçam (intervalo × 2, × 4… até `retry.max_backoff_secs`, padrão 600 s, com ±10% de variação) e voltam ao normal no primeiro sucesso. O evento de falha é gravado uma vez por sequência (antes: um por ciclo) e um "restabelecida" na volta; o log só repete em patamares (1ª, 2ª, 4ª, 8ª… falha).
- **Ping sem backoff** de propósito (destino fora continua sendo testado no intervalo dele); o backoff entra na **resolução de DNS**: IP em cache por `ping.dns_cache_secs` e nome que não resolve espera 1, 2, 4… s antes de nova consulta.
- **Configuração validada com rigor**: campo desconhecido no `.toml` é erro (com a linha e os nomes válidos), valores fora da faixa são erro em vez de corrigidos em silêncio, módulo desconhecido em `NETNOC_COLLECTOR_MODULES` é erro, e todos os problemas aparecem juntos. Novas opções `ping.dns_cache_secs` e `[retry]`.
- **Testes**: de 5 para 28 (+1 opcional com ICMP real) — MikroTik e AdGuard simulados por um servidor HTTP local (sucesso, 401, 500, JSON inválido, timeout, conexão recusada), agendador de ping com sonda simulada gravando num SQLite de verdade, backoff, configuração e cache de DNS. `cargo clippy` sem avisos.
- O crate virou biblioteca + binário (`src/lib.rs`), o que permite os testes de integração em `tests/`.

**API (`netnoc/web/`)**
- `app.py` (≈1800 linhas, 122 rotas) dividido em **10 roteadores por domínio** (`APIRouter`, o equivalente aos Blueprints do Flask) em `netnoc/web/rotas/` — sistema, métricas, painel, destinos, integrações, alertas, ferramentas, multi-site, autenticação, páginas — e `comum.py`. Cada arquivo importa só o que usa. A tabela de rotas foi comparada antes e depois: idêntica (método, caminho e função).

**Dependências**
- `cryptography`, `pydantic` e `starlette` presos à versão maior (antes o `cryptography` estava aberto). Para travar tudo como está funcionando no seu Pi: `venv/bin/pip freeze > requirements.lock` — o `install.sh` passa a usar o lock quando ele existe, e o `reinstalar.sh` o guarda junto com o banco e a chave.

## v3.12 — o NetNOC age (com sua permissão) e volta no tempo
- **Código reorganizado em módulos**: os arquivos `.py` saíram da raiz para o pacote `netnoc/`, uma pasta por módulo — `nucleo` (banco, segurança, estatísticas, backup), `coleta` (ping, incidentes, MikroTik, AdGuard, SNMP, agentes), `analise` (diagnóstico, narrativa, máquina do tempo, SLA), `alertas`, `bot` (Telegram, IA, ações), `integracoes` (câmeras, Zabbix) e `web` (API). Cada pasta tem um README com o que faz, o histórico de mudanças e as próximas melhorias; `static/` e `agente/` também. O `main.py` da raiz continua sendo o ponto de entrada, então o serviço (`uvicorn main:app`), o `install.sh`, o `reinstalar.sh` e o coletor Rust não mudam. O agente remoto agora fica em `agente/agent.py`.
  - Quem atualiza copiando arquivos (sem `git pull` ou `reinstalar.sh`): depois de copiar, apague os `.py` antigos da raiz, menos `main.py` e `manage.py`.
- **Ações pelo Telegram, sempre com confirmação.** `/pppoe` reinicia a conexão PPPoE do MikroTik, `/acordar <PC>` liga um computador pela rede (Wake-on-LAN, pelo servidor e pelo MikroTik), `/bloquear` e `/desbloquear <aparelho>` cortam ou liberam o acesso de um aparelho (lista `netnoc-bloqueados` + uma regra "NetNOC" no topo do firewall, criada uma vez). Cada pedido chega com os botões **Sim / Cancelar**; nada acontece sem o "Sim", o botão vale só para o seu chat, expira em 3 minutos e não executa duas vezes. Tudo vai para a auditoria. Desligado por padrão: Configurações → Alertas → Bot → "Permitir ações no roteador" (precisa de um usuário do MikroTik com permissão de escrita).
- **Aparelho novo na rede**: quando um MAC nunca visto aparece no DHCP do MikroTik, chega um aviso no Telegram com nome, IP e MAC — e, com as ações ligadas, os botões **🚫 Bloquear / 👍 É meu**.
- **Quem está usando a internet agora**: `/banda` mostra download e upload por aparelho (torch do MikroTik; se não der, a taxa das conexões). `/aparelhos` lista os conectados e os novos da semana, `/bloqueados` os bloqueados.
- A IA ganhou as ferramentas `banda`, `aparelhos` e `acao` — esta só **pede** a confirmação com os botões, nunca executa sozinha.
- **Máquina do tempo no mapa**: em Topologia → Mapa, uma régua com as quedas marcadas em cores permite arrastar para qualquer momento das últimas 6 h, 24 h ou 7 dias e ver a rede como estava (estados, ligações e os problemas daquele instante, com a causa). Botões de voltar/avançar, **reproduzir** e **Ao vivo**. Na linha do tempo da página inicial, cada queda tem **"Ver o mapa nesse momento"**. Mais antigo que os pings brutos (7 dias), usa os agregados de 5 minutos.
- Corrigido: o diagnóstico automático consultava o MikroTik num endereço errado e o considerava fora do ar ("API sem resposta"); agora lê uptime, WAN e PPPoE corretamente.

## v3.11 — o NetNOC investiga sozinho
- **Diagnóstico automático da causa.** Quando algo cai ou piora, o NetNOC espera alguns segundos pelas quedas simultâneas e investiga como um analista de NOC: pinga o gateway e a internet (1.1.1.1 e 8.8.8.8), testa o DNS da rede e um DNS público, consulta o MikroTik ao vivo (reiniciou? a porta WAN tem link? o PPPoE está conectado? o link está saturado?), vê o que mais caiu junto e as dependências, e roda traceroute quando ajuda. Chega a uma **causa provável com nível de confiança**, explicação e o que fazer:
  operadora (PPPoE caiu, ONU sem link, internet fora), falha local (o servidor não alcança o roteador), MikroTik reiniciou, só um aparelho, o equipamento do qual vários dependem, parte da rede local, só o serviço externo, DNS da rede, perda/latência dentro da rede, operadora instável, banda saturada.
- O diagnóstico vai para o **Telegram** logo depois do alerta, com as evidências (✅/❌), e fica gravado no histórico.
- **Falta de energia**: ao ligar, o NetNOC detecta o período em que ficou sem dados e diz se o servidor reiniciou nesse meio-tempo (provável falta de energia) ou se só o serviço ficou parado.
- **A rede contada** na página inicial: uma frase que diz como está tudo ("Tudo estável há 3 dias" / "Agora: Google fora há 4 min — operadora"), o resumo das últimas 24 h com o tempo fora do ar por causa, padrões de horário e a **linha do tempo** dos episódios com a causa de cada um (clique para ver evidências e o que fazer). Botão **Diagnosticar agora**.
- **Diário da rede** no Telegram, todo dia no horário escolhido (Configurações → Alertas → Bot): quedas com causa, disponibilidade, pior latência, speedtest e padrões. Também pelo comando `/diario`.
- Bot: novo comando `/diagnostico [destino]`; a IA ganhou as ferramentas `diagnosticar` e `diagnosticos` para responder "por que caiu?" e "o que aconteceu essa noite?" com a causa.
- Tudo por regras, sem depender de IA, e leve para o Pi 3 (uma investigação por vez).

## v3.10 — Mostradores e bot com IA no Telegram
- **Bot no Telegram**: além de mandar alertas, o NetNOC agora responde. Comandos que funcionam sempre: `/status`, `/ping <destino ou IP> [n]`, `/trace <destino>`, `/alertas`, `/mk`.
- **Perguntas em português com IA** (opcional, cota grátis): **Google Gemini** ou **Groq**. Ex.: "como está o ping pro Google?" — a IA faz o ping na hora, compara com as últimas 24 h e responde; "a internet caiu essa noite?" — consulta os incidentes. Ela só usa ferramentas de leitura (status, ping, traceroute, histórico, incidentes, MikroTik, DNS, speedtest, servidor) e nunca inventa números.
- Segurança: responde só ao Chat ID configurado, nada é alterado pela IA, ping/traceroute com host validado e limite por minuto, chaves cifradas no banco e fora do backup.
- **Nova licença**: uso gratuito, todos os direitos reservados (não é permitido copiar o código, redistribuir, vender nem publicar versões modificadas). Versões anteriores continuam sob MIT. Componentes de terceiros listados em `THIRD-PARTY-NOTICES.txt`.
- Configurações → Alertas → **Bot e IA no Telegram**: escolha da IA, chaves, modelo, e um campo para testar a pergunta sem o celular.
- Nova cena **Mostradores** no Modo TV: um aparelho redondo por destino, no estilo termostato de parede, com anel serrilhado, visor preto e números grandes. O anel gira conforme a latência; brilho âmbar quando o destino está degradado e vermelho pulsando quando cai. O visor mostra latência, jitter, perda, disponibilidade 24 h e qualidade em barras. O primeiro mostrador traz a saúde da rede e o relógio.
- Ajusta sozinho o tamanho e o número de colunas para caber na tela (até 15 destinos, problemas primeiro). O aparelho fica escuro em qualquer tema.
- Entra uma vez no rodízio de quem já tinha o Modo TV configurado. Para deixar só ela na parede: `#tv?cenas=6&tempo=0`.
- Visual inspirado no [hc-dial-card](https://github.com/Gyuszko55/hc-dial-card) (MIT).

## v3.9 — coletor em Rust (opcional)
- Novo **`netnoc-collector`** (pasta `collector/`): binário Rust que assume o **ping** de todos os destinos (ICMP nativo, sem criar um processo `ping` a cada medição, mais TCP e HTTP), o **MikroTik** e o **AdGuard Home**, gravando no mesmo banco. Usa poucos MB de RAM, sondas em paralelo, 1 commit por segundo e encerramento limpo no SIGTERM. Veja `collector/README.md`.
- O Python continua com a API, o painel, os incidentes, os rollups, o DHCP, o DNS e o speedtest. Com `NETNOC_EXTERNAL_COLLECTOR=ping,mikrotik,agh` ele para esses três workers e só lê as amostras novas para avaliar incidentes, sem mudar a lógica.
- **Volta automática**: se o coletor parar, o NetNOC volta a coletar sozinho na hora (e registra um evento); quando o coletor reaparece, ele devolve a coleta. Para desfazer de vez: `collector/instalar-coletor.sh --remover`.
- Configurações → Coletores mostra também `rust:ping`, `rust:mikrotik` e `rust:agh`.
- `instalar-coletor.sh` (instala como serviço, sem root, só com `CAP_NET_RAW`) e `medir.sh` (CPU, RAM, forks e escrita no cartão, antes × depois).
- `reinstalar.sh` para e reinicia o coletor junto com o NetNOC.

## v3.8 — visual Pro
- Novo tema **Pro**, agora o padrão: console de operações com menu lateral agrupado (Monitoramento, Serviços, Sistema), superfícies planas em ardósia, um único azul de destaque e cores reservadas para estado (verde, âmbar, vermelho). Números em fonte tabular, endereços em monoespaçada. Escuro e claro.
- **Ícones novos** em todo o painel (conjunto Lucide, traço uniforme), em todos os temas.
- **Marca nova**: logo, ícone do app (PWA) e tela de login redesenhada. O login não carrega mais fontes da internet.
- Ícones de traço no fundo dos cards não aparecem mais como blocos sólidos.
- Quem já escolheu um tema continua com ele; para usar o novo: Configurações → Aparência → Pro.

## v3.7 — tema Lagoa
- Novo tema **Lagoa** (Configurações → Aparência), no estilo painel de casa inteligente: fundo azul-petróleo com brilho, cards claros foscos para o que está online e escuros para o que está fora, ícones verde-limão, botão de status no canto do card e barra de navegação em pílula com rótulos. Modos **Petróleo** e **Noite**. Vale também para a página inicial, mapa, telas e Modo TV.
- Porcentagens logo abaixo de 100 (ex.: 99,96%) não aparecem mais como "100.0%".

## v3.6 — configuração e histórico em arquivos separados
- `netnoc.db` agora guarda **só a configuração** (destinos, grupos, integrações, usuários, aparelhos do DHCP) e fica com poucos KB.
- Pings, médias, DNS, speedtests, incidentes, eventos e logs vão para **`netnoc-historico.db`**, que pode ser apagado a qualquer momento (botão em Configurações → Geral → Dados, ou apagando o arquivo com o serviço parado). A configuração não é afetada.
- Na primeira execução, bancos antigos são separados automaticamente (o histórico é movido, nada se perde).
- Configurações → Geral mostra o tamanho de cada arquivo, com botões para apagar o histórico e compactar.
- **`reinstalar.sh`**: backup automático (configuração, chave, histórico, serviço), reinstalação limpa com a última versão e restauração dos dados; também `--desinstalar`, `--backup` e `--restaurar`. Volta a versão anterior se algo falhar.

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
