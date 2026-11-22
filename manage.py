#!/usr/bin/env python3
"""Utilitário de administração:

  python manage.py reset-admin               nova senha aleatória para o admin
  python manage.py set-password <usuario>    define a senha (pergunta sem mostrar)
  python manage.py secrets                   lista os segredos salvos e se estão cifrados
  python manage.py protect                   cifra o que estiver em texto puro e corrige a permissão da chave
  python manage.py rotate-key                gera chave nova e recifra tudo (pare o NetNOC e o coletor antes)
  python manage.py audit [N]                 últimas N linhas da auditoria (padrão 30)
  python manage.py backup [--historico]      gera o backup (.tar.gz) aqui na pasta, sem mandar ao Telegram
  python manage.py restaurar <arquivo.tar.gz> volta um backup (pare o NetNOC e o coletor antes)
  python manage.py migracoes                 versão do banco (configuração e histórico) e migrações aplicadas
"""
import getpass, secrets, sys
from netnoc.nucleo import db
from netnoc.nucleo import security

RESTORE_FILES = ("netnoc.db", "netnoc-historico.db", "config.json")


def restaurar(path):
    """Extrai só os arquivos conhecidos (nada de caminhos estranhos no .tar), guarda os atuais ao lado
    com o sufixo .antes-<data> e confere se a chave atual abre as senhas do backup."""
    import os, shutil, tarfile, time
    if not os.path.isfile(path):
        print("Arquivo não encontrado:", path); return 1
    if "--yes" not in sys.argv:
        print("Isto substitui a configuração atual pela do backup (os arquivos atuais ficam guardados).\n"
              "Antes, pare os serviços:\n  sudo systemctl stop netnoc netnoc-collector\n"
              f"Depois rode:  python manage.py restaurar {path} --yes")
        return 1
    stamp = time.strftime("%Y%m%d-%H%M%S")
    with tarfile.open(path, "r:gz") as tar:
        members = {m.name: m for m in tar.getmembers() if m.isfile() and m.name in RESTORE_FILES}
        if "netnoc.db" not in members:
            print("Não é um backup do NetNOC (falta netnoc.db)."); return 1
        for name, m in members.items():
            if os.path.exists(name):
                shutil.copy2(name, f"{name}.antes-{stamp}")
            for suf in ("-wal", "-shm"):
                if os.path.exists(name + suf):
                    os.remove(name + suf)
            src = tar.extractfile(m)
            tmp = name + ".restaurando"
            with open(tmp, "wb") as f:
                shutil.copyfileobj(src, f)
            os.replace(tmp, name)
            print(f"  {name} restaurado" + (f" (o anterior ficou em {name}.antes-{stamp})" if os.path.exists(f"{name}.antes-{stamp}") else ""))
    db.init_db()
    from netnoc.nucleo import cofre
    inv = cofre.inventory()
    bad = [r["label"] for r in inv["items"] if r["state"] == "cifrado" and not _opens(r)]
    if bad:
        print("ATENÇÃO: a chave netnoc.key daqui não abre as senhas do backup (" + ", ".join(bad) + ").\n"
              "Copie a chave do Pi antigo para esta pasta, ou digite as senhas de novo nas configurações.")
    print("Pronto. Inicie:  sudo systemctl start netnoc netnoc-collector")
    return 0


def _opens(row):
    import json
    raw = db.get_setting(row["key"])
    try:
        cfg = json.loads(raw) if row["key"] != "session_secret" else raw
    except ValueError:
        return True
    if not isinstance(cfg, dict):
        return True
    v = cfg
    for part in row["field"].split("."):
        v = v.get(part, "") if isinstance(v, dict) else ""
    return not v or bool(security.decrypt(v))


def main():
    if len(sys.argv) < 2:
        print(__doc__); return 1
    if sys.argv[1] == "restaurar":
        if len(sys.argv) < 3:
            print(__doc__); return 1
        return restaurar(sys.argv[2])
    db.init_db()
    cmd = sys.argv[1]
    if cmd == "reset-admin":
        pw = secrets.token_urlsafe(12)
        security.set_user("admin", pw, "admin")
        print("Senha do admin redefinida:", pw)
    elif cmd == "set-password" and len(sys.argv) >= 3:
        user = sys.argv[2]
        if len(sys.argv) > 3:
            print("Aviso: senha passada na linha de comando fica no histórico do shell. "
                  "Prefira: python manage.py set-password <usuario>")
        pw = sys.argv[3] if len(sys.argv) > 3 else getpass.getpass("Nova senha: ")
        if len(pw) < 8:
            print("Mínimo 8 caracteres"); return 1
        role = security._users().get(user, {}).get("role", "admin" if user == "admin" else "viewer")
        security.set_user(user, pw, role)
        print("OK")
    elif cmd == "secrets":
        from netnoc.nucleo import cofre
        inv = cofre.inventory()
        k = inv["key"]
        print(f"chave: {'variável NETNOC_SECRET_KEY' if k['source'] == 'env' else k['path']}"
              + (f"  permissão {k['mode']}" if k.get("mode") else "") + ("" if k["ok"] else "  ← ATENÇÃO"))
        for r in inv["items"]:
            if r["state"] != "vazio":
                print(f"  {r['state']:<11} {r['label']}" + (f" · {r['field']}" if r["field"] else ""))
        print(f"{inv['encrypted']} cifrado(s), {inv['plain']} em texto puro. Só hash: {', '.join(inv['hashed'])}")
        return 1 if inv["plain"] else 0
    elif cmd == "protect":
        from netnoc.nucleo import cofre
        ch = cofre.harden()
        print("Nada a fazer: tudo já estava protegido." if not ch else "Protegido: " + ", ".join(ch))
    elif cmd == "rotate-key":
        from netnoc.nucleo import cofre
        if "--yes" not in sys.argv:
            print("Isto troca a chave que cifra as senhas. Antes, pare os serviços:\n"
                  "  sudo systemctl stop netnoc netnoc-collector\n"
                  "Depois rode de novo com --yes e inicie os serviços.")
            return 1
        r = cofre.rotate_key()
        db.audit("manage.py", "local", "rotate-key", f"{r['values']} valores")
        print(f"OK: {r['values']} valor(es) recifrado(s). Chave anterior guardada em {r['backup']} (0600).\n"
              "Inicie: sudo systemctl start netnoc netnoc-collector")
    elif cmd == "backup":
        from netnoc.nucleo import guarda
        name, data = guarda.build("--historico" in sys.argv)
        with open(name, "wb") as f:
            f.write(data)
        print(f"{name} ({len(data) // 1024} KB). A chave netnoc.key não vai dentro: guarde-a separado.")
    elif cmd == "migracoes":
        from netnoc.nucleo import migracoes
        for sch, e in migracoes.estado(db._writer()).items():
            print(f"{'configuração (netnoc.db)' if sch == 'main' else 'histórico (netnoc-historico.db)'}: versão {e['versao']} de {e['ultima']}"
                  + ("" if not e["pendentes"] else "  pendentes: " + "; ".join(e["pendentes"])))
    elif cmd == "audit":
        n = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].isdigit() else 30
        import time as _t
        for r in reversed(db.query("SELECT * FROM audit_log ORDER BY ts DESC LIMIT ?", (n,))):
            print(f"{_t.strftime('%d/%m %H:%M:%S', _t.localtime(r['ts']))}  {r['user']:<12} {r['ip']:<15} {r['action']}  {r['detail']}")
    else:
        print(__doc__); return 1
    return 0

if __name__ == "__main__":
    sys.exit(main())
