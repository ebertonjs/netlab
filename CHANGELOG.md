# Histórico de versões

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
