# Alertas (`netnoc/alertas`)

Para onde vão os avisos e quando eles ficam em silêncio.

| Arquivo | O que faz |
|---|---|
| `notifier.py` | Fila única de notificações com envio em segundo plano e nova tentativa: **Telegram** (texto e foto da câmera), **Discord**, **webhook** genérico com assinatura HMAC e **e-mail** SMTP. Severidade mínima por canal e **janelas de manutenção** (silencia tudo ou só alguns destinos). |

**Usa:** núcleo, coleta. **Usado por:** coleta (incidentes), análise (diagnóstico, energia).

## Mudanças
- **v3.12** — pasta própria.
- **v3.11** — passa a levar a mensagem do **diagnóstico** (causa + evidências) logo depois de cada alerta, respeitando severidade e manutenção.
- **v3.3** — erros do Telegram mostram o motivo real sem expor o token; foto da última imagem da câmera em perda de vídeo/falha no HD.
- **v2.9** — Chat ID salvo corretamente ao trocar; nome da aplicação nas mensagens.
- **v2.x** — Discord, webhook HMAC, e-mail e manutenção.

## Melhorias desta versão
- O alerta e o diagnóstico seguem o mesmo filtro (severidade e manutenção): nada chega fora de hora.

## Próximas melhorias
- Agrupar alertas em rajada (ex.: 10 destinos caindo juntos viram uma mensagem só, já com a causa).
- Escalonamento: se ninguém reagir em X minutos, repetir ou mandar para outro canal.
- Horário silencioso (madrugada só Alta).
