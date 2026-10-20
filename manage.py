#!/usr/bin/env python3
"""Utilitário de administração: python manage.py reset-admin | set-password <usuario> [senha]"""
import getpass, secrets, sys
import db, security

def main():
    if len(sys.argv) < 2:
        print(__doc__); return 1
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
    else:
        print(__doc__); return 1
    return 0

if __name__ == "__main__":
    sys.exit(main())
