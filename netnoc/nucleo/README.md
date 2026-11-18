# Núcleo (`netnoc/nucleo`)

A base que todos os outros módulos usam: onde os dados ficam, quem pode entrar, como as senhas são guardadas e como a configuração sai e volta num backup.

| Arquivo | O que faz |
|---|---|
| `db.py` | SQLite em dois arquivos: `netnoc.db` (configuração, poucos KB) e `netnoc-historico.db` (medições, incidentes, eventos, diagnósticos — pode ser apagado). Modo WAL, um único escritor, leitores por thread, rollups de 5 min e 1 h, limpeza e compactação. |
| `security.py` | Login e sessões (cookie assinado), usuários e perfis (admin/visualizador), limite de tentativas por IP + usuário, CSRF (cabeçalho `X-NetNOC` + mesma origem), CSP, validação de host/URL/porta/nome e **cifra das senhas** guardadas (Fernet, prefixo `enc:v1:`, chave em `netnoc.key`). |
| `stats.py` | Séries de latência/perda/jitter por destino em qualquer janela (bruto na última hora, agregados depois), disponibilidade e barras por hora. |
| `backup.py` | Exporta a configuração em JSON **sem nenhuma senha/chave** e importa validando tudo antes de gravar; segredos já salvos são mantidos se o destino não mudou. |

**Usado por:** todos os módulos. **Usa:** nada do NetNOC (só bibliotecas).

## Mudanças
- **v3.12** — vira pasta própria do pacote `netnoc`. Nova tabela `diagnoses` no histórico (com limpeza junto com os eventos). O backup leva a configuração do bot/IA (chaves fora).
- **v3.10** — backup inclui o bot e a IA (provedor, modelo, opções), sem as chaves.
- **v3.6** — configuração e histórico separados em dois arquivos; migração automática dos bancos antigos; botões para apagar o histórico e compactar.
- **v3.3** — limite de tentativas por IP + usuário (sessão válida nunca é bloqueada), CSP atualizada, WebSocket com sessão.
- **v3.0** — tela de login própria, sessão por cookie assinado.
- **v2.x** — rollups 5 min / 1 h, backup/restauração, cifra das credenciais.

## Melhorias desta versão
- Imports explícitos (`from netnoc.nucleo import db`): fica claro quem depende do núcleo.
- Diagnósticos guardados no histórico, apagados junto com ele e respeitando a retenção.

## Próximas melhorias
- Rotação automática da chave `netnoc.key` (recifrar tudo com uma chave nova).
- Exportar o histórico (CSV/Parquet) antes de apagar.
- Usuário só-leitura com acesso limitado a destinos/grupos.
