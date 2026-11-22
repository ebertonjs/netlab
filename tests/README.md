# Testes

```
pip install -r requirements-dev.txt
pytest -q
```

Cada arquivo em `cenarios/` é um script que sobe um MikroTik, um DVR e um Telegram falsos e confere o comportamento real do NetNOC. O `test_cenarios.py` roda cada um num processo e numa pasta temporária própria (os módulos usam `config.json`, `netnoc.db` e `static/` relativos à pasta atual). Um cenário passa quando termina sem erro e imprime `TUDO OK`.

Para um cenário novo: copie um dos existentes, use `ok(condição, "mensagem")` para cada verificação e termine com `print("TUDO OK")`.
