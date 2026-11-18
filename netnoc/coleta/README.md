# Coleta (`netnoc/coleta`)

Tudo que mede a rede e decide quando algo virou um problema.

| Arquivo | O que faz |
|---|---|
| `monitor.py` | O coração da coleta. Coletores supervisionados (uma exceção não derruba a thread): ping/TCP/HTTP dos destinos, DNS, IP público, sistema (CPU, RAM, temperatura, disco), MikroTik (REST: recurso, interfaces, DHCP), AdGuard Home, certificados, speedtest automático. Janela de avaliação por tempo e **abertura/fechamento de incidentes** (offline, perda, latência, jitter, queda local), supressão em cascata pelo "Depende de". Ganchos `INCIDENT_HOOKS` e `NEW_DEVICE_HOOKS` para os outros módulos reagirem. Lê do **coletor Rust** quando ele está ativo e volta a coletar sozinho se ele parar. |
| `checks.py` | Sondas além do ICMP: TCP, HTTP(S) com status esperado, validade de certificado, traceroute, IPv4 × IPv6, descoberta de aparelhos na rede e `ping_many` (vários pings de uma vez, usado pelo bot e pelo diagnóstico). |
| `snmp.py` | Equipamentos SNMP (v1, v2c e v3, pelo net-snmp; credenciais nunca aparecem na linha de comando): leitura, limites e histórico. |
| `sites.py` | Recebe os resultados dos **agentes remotos** (`agente/agent.py`) de outros sites, com token por site e vigia de agente sumido. |

**Usa:** núcleo, alertas. **Usado por:** análise, bot, web.

## Mudanças
- **v3.12** — vira pasta própria. Novo gancho `NEW_DEVICE_HOOKS`: o DHCP do MikroTik avisa quando aparece um MAC nunca visto (a primeira sincronização é só a linha de base). `ping_many` em `checks.py`, com alternativa para `ping` sem a opção `-i`.
- **v3.11** — gancho `INCIDENT_HOOKS` chamado na abertura de cada incidente (alimenta o diagnóstico automático).
- **v3.9** — modo coletor externo: com `NETNOC_EXTERNAL_COLLECTOR` o Python só lê as amostras do Rust e mantém a mesma avaliação; heartbeat, volta automática e saúde `rust:*`.
- **v3.4** — speedtest automático diário; DHCP do MikroTik com aparelhos na rede.
- **v3.3** — coletores supervisionados, janela de avaliação por tempo, queda local como um único alerta, DNS lento só após 3 medições.
- **v2.x** — checks TCP/HTTP, SNMP, multi-site com agentes.

## Melhorias desta versão
- Os outros módulos reagem a eventos da coleta por ganchos, sem a coleta conhecer quem está ouvindo (diagnóstico e bot plugam sem mexer aqui).
- Aviso de aparelho novo sem falso positivo na primeira leitura do DHCP.

## Próximas melhorias
- Dividir `monitor.py` (≈1500 linhas) em `ping.py`, `incidentes.py`, `mikrotik.py`, `adguard.py`, `sistema.py`.
- "Normal por hora da semana" (fase 3): limites aprendidos em vez de fixos.
- Identificar celulares com MAC aleatório para não gerar avisos repetidos.
