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

O script instala `gcc`, `python3-dev`, `python3-venv`, `snmp`, `traceroute`, `iputils-ping`, baixa o **go2rtc** (vídeo das câmeras) para a sua arquitetura, cria o ambiente virtual `venv/` e instala as bibliotecas Python. Rode **sem** `sudo`: o script pede a senha só quando precisa. Na Raspberry Pi leva alguns minutos (compilação do `psutil`).

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

Jeito manual: copie `netnoc.service.example` para `/etc/systemd/system/netnoc.service`, ajuste `User` e os caminhos, depois `sudo systemctl daemon-reload && sudo systemctl enable --now netnoc`.

## 6. Configuração inicial (pela interface)

Entre em **Configurações** e faça, nesta ordem:

1. **Nome da aplicação** — o nome aparece no menu, login, Modo TV, alertas e relatórios.
2. **Destinos** — cadastre o que monitorar (ICMP, TCP ou HTTP). Use *alvo pai* para evitar alertas em cascata.
3. **Telegram** (alertas): crie o bot no `@BotFather`, copie o token; descubra seu *chat id* com `@userinfobot`. Preencha, salve e clique em **Enviar teste**. Discord, webhook e e-mail ficam em **Notificações**.
4. **Integrações** (opcional): MikroTik (RouterOS v7), AdGuard Home, DVR Intelbras, SNMP, Zabbix.
5. **Aparência**: tema (Glass, NOC Terminal, Grafana/Zabbix ou Material You), modo, cor e tamanho da interface.
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

Guarde sempre **os dois** arquivos: `netnoc.db` (dados) e `netnoc.key` (chave dos segredos). Sem a chave, tokens e senhas salvos não abrem.
```bash
sudo systemctl stop netnoc
cp netnoc.db netnoc.key ~/backup-netnoc/
sudo systemctl start netnoc
```
Também há backup/restauração pela interface (sem segredos).

## 11. Atualizar para uma versão nova

```bash
sudo systemctl stop netnoc
cp netnoc.db netnoc.key ~/backup-netnoc/          # segurança
# Git:   git pull
# ZIP:   copie os arquivos novos por cima (não apague netnoc.db / netnoc.key / config.json)
source venv/bin/activate && pip install -r requirements.txt
sudo systemctl start netnoc
```
No navegador, `Ctrl+F5` uma vez. O banco migra sozinho.

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
| Mudei o tema/nome e não mudou | `Ctrl+F5` (cache do PWA) |
| Câmeras ficam em "reconectando" | Procure `cam/ws` nos logs (`journalctl -u netnoc`); atrás de proxy, habilite WebSocket (seção 9) |
| Teste do DVR com `HTTP 404` | Habilite o CGI no DVR; o vídeo ao vivo usa só o RTSP |
| Sessão caiu / volta ao login | Sessão de 12 h (30 dias com "manter conectado"); trocar a senha encerra as sessões |

## 13. Desinstalar

```bash
sudo systemctl disable --now netnoc && sudo rm /etc/systemd/system/netnoc.service
cd .. && rm -rf netlab        # apaga também dados e chave: faça backup antes
```
