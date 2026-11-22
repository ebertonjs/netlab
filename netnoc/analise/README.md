# Análise (`netnoc/analise`)

Transforma medições em respostas: **por que** caiu, **o que** aconteceu, **como estava** em qualquer momento e **quanto** a rede ficou disponível. É o que diferencia o NetNOC de um painel de números.

| Arquivo | O que faz |
|---|---|
| `diagnose.py` | **Diagnóstico automático da causa.** Na abertura de um incidente espera as quedas simultâneas, coleta evidências (gateway, 1.1.1.1/8.8.8.8, DNS da rede e público, MikroTik ao vivo: reinício, link da WAN, PPPoE, saturação; o que caiu junto e dependências; traceroute) e decide a causa provável com confiança, explicação e o que fazer. Detecta também o servidor desligado (provável falta de energia). Uma investigação por vez. |
| `story.py` | **A rede contada.** Frase de estado ("Tudo estável há 3 dias" / "Agora: Google fora há 4 min — operadora"), resumo das 24 h com o tempo fora por causa, episódios agrupados pelo diagnóstico e o **diário** diário enviado no Telegram. |
| `timemachine.py` | **Máquina do tempo.** Estado de cada destino e incidentes abertos em qualquer instante (bruto nos últimos 7 dias, agregados de 5 min antes disso). |
| `sla.py` | Relatório de disponibilidade por destino no mês ou em N dias, com exportação CSV. |

**Usa:** núcleo, coleta, bot (envio do diário). **Usado por:** web, bot.

## Mudanças
- **v4.0** — "internet saturada" compara o download atual da WAN com o maior dos últimos 30 dias (antes, com o último speedtest); o diário traz o pico da WAN no lugar do speedtest; tipos de incidente de SNMP e agente saem da narrativa.
- **v3.12** — pasta própria. `timemachine.py` novo. Corrigido o endereço da consulta ao MikroTik no diagnóstico (antes ele dava o roteador como fora do ar e as evidências de WAN/PPPoE não apareciam).
- **v3.11** — `diagnose.py` e `story.py` novos: cerca de 20 causas reconhecidas (operadora/PPPoE/ONU/instabilidade, falha local, reinício do MikroTik, energia, aparelho, equipamento pai, parte da rede, serviço externo, DNS, perda interna, banda saturada), diário, rótulos curtos por causa nos resumos.
- **v2.x** — relatório de SLA e CSV.

## Melhorias desta versão
- O mapa no passado reaproveita exatamente a mesma montagem do mapa ao vivo (nada duplicado).
- Os diagnósticos guardam as evidências: a linha do tempo, o diário, o bot e o mapa no passado mostram a mesma causa.

## Próximas melhorias
- Fase 2: **dossiê da operadora** em PDF (quedas, durações, causa, pico da WAN × plano) e **notas por uso** (chamada de vídeo, jogo, streaming).
- Fase 3: **normal por hora da semana** e tendência ("a operadora piora 2 ms por semana").
- Aprender com o usuário: marcar um diagnóstico como errado para ajustar as regras.
