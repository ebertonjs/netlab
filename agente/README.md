# Agente remoto (`agente/`)

Script independente para monitorar **outro local** (filial, casa de parente) pelo mesmo NetNOC. Roda em qualquer máquina com Python 3 + `requests`; não precisa do resto do projeto.

```bash
python3 agent.py --url https://noc.exemplo:8000 --site filial-a --token TOKEN [--insecure]
```

O servidor decide quais destinos o agente sonda (os que têm esse site em "sites") e recebe os resultados como `destino@site`. O token é criado em Configurações → Segurança; em cada destino, informe o site (ex.: `filial-a`).

## Mudanças
- **v3.12** — movido da raiz para `agente/agent.py` (o arquivo é o mesmo; copie-o para o site remoto como antes).
- **v2.x** — criado (multi-site).

## Próximas melhorias
- Envio em lote com fila local quando o link do site remoto cai (hoje as medições desse período se perdem).
- Pacote único (binário) para Windows.
