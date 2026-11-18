# Integrações (`netnoc/integracoes`)

Sistemas de terceiros que o NetNOC acompanha.

| Arquivo | O que faz |
|---|---|
| `dvr.py` | **DVR Intelbras** (linha MHDX, API compatível Dahua): canais, eventos (perda de vídeo, falha no HD), fotos e vídeo ao vivo pelo **go2rtc** só enquanto alguém assiste (sem converter vídeo). O binário fica em `bin/go2rtc` e a configuração gerada em `go2rtc.yaml`, na raiz do projeto. |
| `zabbix.py` | Problemas ativos de um servidor **Zabbix** (token de API) exibidos junto com os incidentes do NetNOC. |

(MikroTik e AdGuard ficam em `coleta/monitor.py`, porque são coletados como métricas.)

**Usa:** núcleo, coleta. **Usado por:** web, alertas.

## Mudanças
- **v3.12** — pasta própria; o `dvr.py` passou a localizar `bin/` e `go2rtc.yaml` na raiz do projeto (mesmo lugar de antes, nada muda na instalação).
- **v3.4** — foto tirada do próprio vídeo pelo go2rtc quando o DVR não tem o CGI de foto.
- **v3.3** — câmeras do DVR: mosaico, tela cheia, fotos, alertas com imagem no Telegram, teste que mostra o que o firmware respondeu.
- **v2.x** — Zabbix.

## Melhorias desta versão
- Caminho dos arquivos do go2rtc independente de onde o código mora.

## Próximas melhorias
- Outros DVRs/NVRs (Hikvision ISAPI, ONVIF genérico).
- Gravação de alguns segundos de vídeo quando um alerta de câmera dispara.
