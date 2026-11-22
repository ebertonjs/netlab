# 📘 NetNOC — Tutorial de instalação (passo a passo)

Tempo estimado: 10 minutos. Funciona em Raspberry Pi (OS/DietPi), Debian e Ubuntu.

## 1. O que você precisa

| Item | Detalhe |
|---|---|
| Sistema | Linux com acesso à internet (Raspberry Pi 3/4/5, VM, mini-PC) |
| Python | 3.9 ou superior (`python3 --version`) |
| Acesso | usuário com `sudo` |
| Rede | o equipamento precisa alcançar os alvos que você vai monitorar |

## 2. Baixar o projeto

**Opção A — Git**
```bash
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/ebertonjs/netlab.git
cd netlab
```

**Opção B — arquivo ZIP**
```bash
sudo apt-get install -y unzip
unzip netlab-main.zip
cd netlab-main
```

## 3. Instalar

```bash
chmod +x install.sh
./install.sh
```

O script instala `gcc`, `python3-dev`, `python3-venv`, `traceroute`, `iputils-ping`, baixa o **go2rtc** (vídeo das câmeras) para a sua arquitetura, cria o ambiente virtual `venv/` e instala as bibliotecas Python. Rode **sem** `sudo`: o script pede a senha só quando precisa. Na Raspberry Pi leva alguns minutos (compilação do `psutil`).

> Prefere instalar à mão? Veja "Instalação manual" no `README.md`.

## 4. Primeira execução

```bash
source venv/bin/activate
python3 -m uvicorn main:app --host 0.0.0.0 --port 8000
```

No terminal aparece a senha inicial:

```
NetNOC: usuário inicial 'admin'  senha: xxxxxxxxxxxx
```

Anote. Quer escolher a senha? Antes de subir: `export NETNOC_ADMIN_PASSWORD='sua-senha-forte'`.

Abra no navegador: `http://IP_DO_DISPOSITIVO:8000` (descubra o IP com `hostname -I`). A tela de login aparece — entre com `admin` e a senha acima. Marque **"Manter conectado por 30 dias"** em computadores seus.

Pare com `Ctrl+C`. Para deixar rodando sempre, siga o passo 5.

## 5. Iniciar sozinho no boot (serviço)

Jeito rápido (cria e ativa o serviço systemd automaticamente):
```bash
./install.sh --service
```

Comandos úteis:
```bash
sudo systemctl status netnoc        # estado
sudo systemctl restart netnoc       # reiniciar
sudo journalctl -u netnoc -f        # logs ao vivo
```

Recomendado: `./install.sh --watchdog` (reinicia sozinho se travar; veja a seção 10).

Jeito manual: copie `netnoc.service.example` para `/etc/systemd/system/netnoc.service`, ajuste `User` e os caminhos, depois `sudo systemctl daemon-reload && sudo systemctl enable --now netnoc`.

## 6. Configuração inicial (pela interface)

Entre em **Configurações** e faça, nesta ordem:

1. **Nome da aplicação** — o nome aparece no menu, login, Modo TV, alertas e relatórios.
2. **Destinos** — cadastre o que monitorar (ICMP, TCP ou HTTP). Use *alvo pai* para evitar alertas em cascata.
3. **Telegram** (alertas): crie o bot no `@BotFather`, copie o token; descubra seu *chat id* com `@userinfobot`. Preencha, salve e clique em **Enviar teste**. Discord, webhook e e-mail ficam em **Alertas → Outros canais de alerta**.
4. **Integrações** (opcional): MikroTik (RouterOS v7), AdGuard Home, DVR Intelbras. No MikroTik, a **porta da internet** (WAN) dá a velocidade real do link; vazio, o NetNOC descobre sozinho.
5. **Aparência**: modo escuro, claro ou automático (escuro das 18h às 7h) e tamanho da interface.
6. **Usuários**: em **Segurança**, crie usuários só de leitura para a equipe e **troque a senha do admin**.

## 7. Modo TV (monitor na parede)

Clique em 📺 ou abra `http://IP:8000/#tv`. Teclas: `← →` trocam de cena, `espaço` pausa, `A` dispensa alerta, `S` som, `F` tela cheia, `Esc` sai. Parâmetros na URL: `#tv?cenas=1,2,5&tempo=20` (cena 5 = câmeras).

Em TV/Raspberry dedicada, o login é feito uma vez com "Manter conectado".

## 8. Câmeras (DVR Intelbras)

Em **Configurações → Integrações → DVR**: IP do DVR, usuário (de preferência só de visualização), senha, porta HTTP (80) e RTSP (554). Clique em **Salvar e testar**.

- O vídeo ao vivo só roda enquanto alguém está na tela de Câmeras (ou na cena 5 do Modo TV).
- Os streams precisam estar em **H.264** (*Câmera → Codificação* no DVR); navegadores não tocam H.265.
- Se as consultas do teste voltarem `HTTP 404`, habilite o **CGI** nos serviços de rede do DVR (fotos, nomes e eventos). O vídeo usa só o RTSP.
- Se o go2rtc não foi baixado na instalação, rode `./install.sh` de novo ou coloque o binário em `bin/go2rtc`.

## 9. Acesso seguro de fora (HTTPS)

Não exponha a porta 8000 direto na internet. Use um proxy com HTTPS na frente.

**Caddy (mais simples)** — `/etc/caddy/Caddyfile`:
```
noc.seudominio.com {
    reverse_proxy 127.0.0.1:8000
}
```
O Caddy já envia `X-Forwarded-Proto` e emite o certificado sozinho.

**Nginx** — dentro do `server { listen 443 ssl; ... }`:
```
location / {
    proxy_pass http://127.0.0.1:8000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_buffering off;          # necessário para o tempo real (SSE)
    proxy_http_version 1.1;       # vídeo das câmeras (WebSocket)
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```
Com o proxy, rode o uvicorn só local: troque `--host 0.0.0.0` por `--host 127.0.0.1` no serviço.

Alternativas sem abrir portas: Tailscale ou WireGuard.

## 10. Backup (importante)

**Automático (v4.2):** em Configurações → Geral → *Backup automático e vigia externo*, o NetNOC manda todo dia, no horário escolhido, um `.tar.gz` para o seu Telegram (pelo bot dos alertas). Vai a configuração, os usuários e as senhas **cifradas**; o histórico só se você marcar. No Telegram: `/backup` manda um na hora, `/saude` mostra o último.

A chave `netnoc.key` **nunca** vai no arquivo (quem pegar o backup não lê as senhas). Guarde-a **uma vez** em outro lugar:
```bash
scp usuario@IP_DO_PI:~/netnoc/netnoc.key .     # do PC; guarde num pendrive ou gerenciador de senhas
```

Restaurar (no mesmo Pi ou num novo, com a chave copiada para a pasta):
```bash
sudo systemctl stop netnoc netnoc-collector
venv/bin/python manage.py restaurar netnoc-backup-AAAAMMDD-HHMM.tar.gz --yes
sudo systemctl start netnoc netnoc-collector
```
Os arquivos atuais ficam guardados com o sufixo `.antes-<data>`. Se a chave não for a mesma, o comando avisa quais senhas precisam ser digitadas de novo.

À mão: `venv/bin/python manage.py backup` gera o mesmo arquivo na pasta. Pela interface ainda há o backup em JSON (sem senhas).

### Vigia externo e watchdog

- **Watchdog** (Pi travado sem cair): `./install.sh --watchdog` instala um timer que chama `/healthz` a cada minuto e reinicia o NetNOC depois de 3 falhas seguidas. Ver o que ele fez: `journalctl -t netnoc-watchdog`.
- **Vigia externo** (Pi desligado, sem luz, sem internet): crie uma conta grátis no [healthchecks.io](https://healthchecks.io), um *check* com período de 5 min, e cole a URL de ping na mesma tela do backup. Se os avisos param, o healthchecks.io te avisa por e-mail ou Telegram.

### Medir a velocidade e log do MikroTik (v4.3)

- **Medir agora**: tela do MikroTik → "Velocidade real da internet", ou `/medir` no Telegram. Rode um speedtest no celular/PC durante a medição. Coloque a velocidade do plano em Configurações → Integrações → MikroTik para ver a porcentagem.
- **Syslog**: Configurações → Integrações → *Syslog do MikroTik* → ligar e colar os comandos no terminal do MikroTik. Se o Pi tiver firewall (ufw), libere: `sudo ufw allow from IP_DO_MIKROTIK to any port 5514 proto udp`.

## 11. Atualizar para uma versão nova

Com o zip da atualização (só os arquivos que mudaram):
```bash
cd ~/netnoc
./atualizar.sh ~/netnoc-v4.2.zip
```
Ele guarda o que vai mudar em `atualizacoes/`, aplica, apaga os arquivos que saíram do projeto (lista `REMOVER.txt` no zip), instala dependências novas, reinicia e confere o `/healthz`. **Se o NetNOC não responder, volta sozinho para a versão anterior.** Para voltar depois: `./atualizar.sh --desfazer`. Banco, chave e `config.json` nunca são tocados.

Com Git: `git pull`, `venv/bin/pip install -r requirements.txt` e `sudo systemctl restart netnoc`.

No navegador, `Ctrl+F5` uma vez. O banco migra sozinho.

### Testar antes de subir
```bash
venv/bin/pip install -r requirements-dev.txt
venv/bin/python -m pytest -q
```
Não mexe no NetNOC que está rodando (cada teste usa uma pasta temporária e aparelhos simulados).

## 12. Problemas comuns

| Sintoma | Solução |
|---|---|
| Esqueci a senha do admin | `source venv/bin/activate && python manage.py reset-admin` |
| "Muitas tentativas" no login | Bloqueio de 10 min após 8 erros; aguarde ou reinicie o serviço |
| Página abre mas não atualiza ao vivo | Proxy sem `proxy_buffering off` (SSE) |
| `pip install` falha em `psutil` | `sudo apt-get install -y gcc python3-dev` e rode `./install.sh` de novo |
| Porta 8000 em uso | Troque `--port 8000` no serviço/comando |
| Ping sem resposta no Docker/VM | O equipamento precisa de permissão para ICMP e rota até o alvo |
| Telegram não envia | Use **Enviar teste**; confira token, chat id e se falou `/start` com o bot |
| Mudei o modo/nome e não mudou | `Ctrl+F5` (cache do PWA) |
| Câmeras ficam em "reconectando" | Procure `cam/ws` nos logs (`journalctl -u netnoc`); atrás de proxy, habilite WebSocket (seção 9) |
| Teste do DVR com `HTTP 404` | Habilite o CGI no DVR; o vídeo ao vivo usa só o RTSP |
| Sessão caiu / volta ao login | Sessão de 12 h (30 dias com "manter conectado"); trocar a senha encerra as sessões |

## 13. Reinstalar ou desinstalar (com backup automático)

O `reinstalar.sh` faz tudo sozinho: guarda os arquivos importantes (`netnoc.db`, `netnoc.key`, `netnoc-historico.db`, `config.json` e o serviço), remove, baixa a versão atual do GitHub, devolve os dados e sobe o serviço de novo — mantendo a porta e as variáveis (`Environment=`) que você tinha. Se algo falhar no meio, a instalação anterior volta para o lugar.

```bash
./reinstalar.sh                    # backup + reinstala com a última versão + restaura os dados
./reinstalar.sh --sem-historico    # idem, recomeçando o histórico do zero
./reinstalar.sh --desinstalar      # backup + remove (não instala de novo)
./reinstalar.sh --backup           # só faz o backup
./reinstalar.sh --restaurar ~/netnoc-backup/AAAAMMDD-HHMMSS   # instala usando um backup
```
Os backups ficam em `~/netnoc-backup/<data-hora>/`. Rode **sem sudo** (ele pede a senha quando precisa).

### Fazendo à mão

**Mantendo os dados** (para reinstalar depois sem perder configuração):
```bash
sudo systemctl disable --now netnoc
mkdir -p ~/netnoc-backup
cp netnoc.db* netnoc.key ~/netnoc-backup/                 # configuração + chave das senhas
cp netnoc-historico.db* ~/netnoc-backup/ 2>/dev/null     # opcional: gráficos, SLA e incidentes
sudo rm /etc/systemd/system/netnoc.service && sudo systemctl daemon-reload
cd .. && rm -rf netlab
```

**Reinstalar com os dados guardados:**
```bash
git clone https://github.com/ebertonjs/netlab.git && cd netlab
cp ~/netnoc-backup/* .
./install.sh --service
```

**Apagar tudo** (inclusive dados e chave):
```bash
sudo systemctl disable --now netnoc && sudo rm /etc/systemd/system/netnoc.service
cd .. && rm -rf netlab
```
