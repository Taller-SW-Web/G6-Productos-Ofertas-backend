#!/usr/bin/env bash
set -Eeuo pipefail

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

[[ $# == 1 ]] || fail 'uso: probe-private-endpoint.sh <base-url-https>'
url="$1"
[[ "$url" == https://* ]] || fail 'se requiere URL HTTPS'
[[ "$url" != *'@'* && "$url" != *'?'* && "$url" != *'#'* ]] || fail 'la URL no debe incluir credenciales, query ni fragmento'

host="${url#https://}"
host="${host%%/*}"
host="${host%%:*}"
[[ -n "$host" && "$host" != *' '* ]] || fail 'hostname inválido'

if ! getent ahosts "$host" >/dev/null 2>&1; then
  fail "DNS no resuelve $host desde este runner"
fi
printf 'PASS DNS: %s\n' "$host"

tls_output="$(mktemp)"
trap 'rm -f "$tls_output"' EXIT
if ! timeout 15 openssl s_client -brief -connect "${host}:443" -servername "$host" -verify_return_error </dev/null >"$tls_output" 2>&1; then
  fail "handshake TLS falló para $host (salida resumida omitida)"
fi
if ! grep -Eq 'Verification: OK|Verify return code: 0 \(ok\)' "$tls_output"; then
  fail "el certificado TLS no se verificó para $host (detalle omitido)"
fi
printf 'PASS TLS: %s:443 certificado verificado\n' "$host"
