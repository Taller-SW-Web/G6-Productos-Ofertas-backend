#!/usr/bin/env bash
set -Eeuo pipefail

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

[[ $# == 1 ]] || fail 'uso: probe-private-endpoint.sh <origen-https>'
url="$1"

# Accept only an HTTPS DNS origin, optionally followed by one slash. This
# rejects userinfo, password, port, IPv6 literals, query, fragment and paths.
origin_re='^https://(([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)(:443)?/?$'
[[ "$url" =~ $origin_re ]] || fail 'se requiere un origen HTTPS DNS sin credenciales, puerto, ruta, query o fragmento'
host="${BASH_REMATCH[1],,}"
(( ${#host} <= 253 )) || fail 'hostname excede 253 caracteres'

if ! getent ahosts "$host" >/dev/null 2>&1; then
  fail "DNS no resuelve $host desde este runner"
fi
printf 'PASS DNS: %s\n' "$host"

tls_output="$(mktemp)"
trap 'rm -f "$tls_output"' EXIT
if ! timeout 15 openssl s_client -brief \
  -connect "${host}:443" \
  -servername "$host" \
  -verify_hostname "$host" \
  -verify_return_error </dev/null >"$tls_output" 2>&1; then
  fail "handshake/cadena/hostname TLS falló para $host (detalle omitido)"
fi
if ! grep -Eq 'Verification: OK|Verify return code: 0 \(ok\)' "$tls_output"; then
  fail "OpenSSL no confirmó la verificación TLS para $host (detalle omitido)"
fi
printf 'PASS TLS: %s:443 cadena y hostname verificados\n' "$host"
