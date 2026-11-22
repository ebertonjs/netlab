"""HTTPS com certificado fixado (pinning) para aparelhos da rede com certificado próprio.

O MikroTik gera um certificado autoassinado: nenhuma autoridade o reconhece, então `verify=True`
falha e `verify=False` aceita qualquer um (inclusive de um impostor na rede). O meio-termo seguro é
guardar a impressão digital SHA-256 do certificado na primeira conexão (o usuário confere com a que
o RouterOS mostra) e recusar qualquer outro depois. O coletor Rust faz a mesma conferência.
"""
import hashlib, re, socket, ssl

import requests
from requests.adapters import HTTPAdapter

_HEX = re.compile(r"^[0-9a-f]{64}$")


def norm(fp):
    """'AB:CD:…' ou 'abcd…' -> 64 dígitos hex minúsculos; '' se vazio; ValueError se inválido."""
    s = re.sub(r"[\s:]", "", str(fp or "")).lower()
    if not s:
        return ""
    if not _HEX.match(s):
        raise ValueError("Impressão digital inválida: são 64 dígitos hexadecimais (SHA-256)")
    return s


def pretty(fp):
    fp = norm(fp)
    return ":".join(fp[i:i + 2] for i in range(0, len(fp), 2)).upper()


def fetch(host, port, timeout=6):
    """Conecta sem validar e devolve a impressão digital SHA-256 do certificado apresentado."""
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    with socket.create_connection((host, int(port)), timeout=timeout) as raw:
        with ctx.wrap_socket(raw, server_hostname=host if not _is_ip(host) else None) as s:
            der = s.getpeercert(binary_form=True)
    if not der:
        raise ValueError("o aparelho não apresentou certificado")
    return hashlib.sha256(der).hexdigest()


def _is_ip(h):
    try:
        socket.inet_pton(socket.AF_INET6 if ":" in h else socket.AF_INET, h)
        return True
    except OSError:
        return False


class _PinAdapter(HTTPAdapter):
    def __init__(self, fp, **kw):
        self._fp = fp
        super().__init__(**kw)

    def init_poolmanager(self, *a, **kw):
        kw["assert_fingerprint"] = self._fp      # urllib3 compara o certificado com o pino
        kw["cert_reqs"] = "CERT_NONE"            # a cadeia não importa: só o pino vale
        return super().init_poolmanager(*a, **kw)


_sessions = {}


def session(fp):
    """Sessão requests que só aceita o certificado com esta impressão digital (reaproveitada)."""
    fp = norm(fp)
    s = _sessions.get(fp)
    if s is None:
        s = requests.Session()
        s.mount("https://", _PinAdapter(fp))
        _sessions[fp] = s
    return s


def request(cfg, method, url, **kw):
    """requests.request respeitando a config do aparelho: pino > verify_ssl."""
    fp = cfg.get("cert_sha256") if cfg.get("use_https") else ""
    if fp:
        kw.pop("verify", None)
        try:
            return session(fp).request(method, url, verify=False, **kw)
        except requests.exceptions.SSLError as e:
            if "fingerprint" in str(e).lower():
                raise requests.exceptions.SSLError(
                    "o certificado do aparelho mudou (impressão digital diferente da salva)") from None
            raise
    kw.setdefault("verify", bool(cfg.get("verify_ssl")))
    return requests.request(method, url, **kw)
