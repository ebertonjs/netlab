"""Ponto de entrada do NetNOC.

O código fica no pacote netnoc/ (um módulo por pasta). Este arquivo existe para o serviço e os
scripts continuarem iguais:  python -m uvicorn main:app --host 0.0.0.0 --port 8000
"""
from netnoc.web.app import APP_VERSION, app  # noqa: F401
