# Atualização v3.3 — interface nova, temas, Modo TV e câmeras

## Como atualizar

```bash
sudo systemctl stop netnoc
cp netnoc.db netnoc.key ~/backup-netnoc/
git pull
./install.sh                 # baixa o go2rtc e instala a dependência nova (websockets)
sudo systemctl start netnoc
```

No navegador, `Ctrl+F5` uma vez. A interface nova abre em `/`; a anterior continua em `/classic`.

## O que mudou

Veja o resumo em [CHANGELOG.md](../CHANGELOG.md). Pontos de atenção:

- **Temas e tamanho** ficam em **Configurações → Aparência** e valem por aparelho. O admin pode definir o tema padrão do servidor.
- **Modo TV**: a cena Câmeras entra no rodízio sozinha quando o DVR está configurado (dá para desmarcar).
- **Câmeras**: configure em **Configurações → Integrações → DVR** e use **Salvar e testar**. Streams em H.264; se o teste mostrar `HTTP 404`, habilite o CGI no DVR. Detalhes no [INSTALL.md](../INSTALL.md#8-câmeras-dvr-intelbras).
- **Proxy reverso**: o vídeo das câmeras usa WebSocket; no Nginx, adicione `Upgrade`/`Connection` (exemplo no INSTALL.md).
- **Limite de login** agora conta por IP + usuário; quem já está logado nunca é bloqueado.
- `config.json` ganhou `window_seconds`, `window_min_samples`, `dns_slow_consecutive` e `host_label` (só valem na primeira execução; depois tudo fica no banco).
