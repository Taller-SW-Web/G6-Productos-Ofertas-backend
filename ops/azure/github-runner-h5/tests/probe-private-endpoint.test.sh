#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT
export H5_OPENSSL_CALL_LOG="$TEMP/openssl-calls"

cat > "$TEMP/getent" <<'MOCK'
#!/usr/bin/env bash
[[ "${1:-}" == ahosts ]] || exit 2
case "${2:-}" in
  dns-ok.example.internal|cert-bad.example.internal|hostname-bad.example.internal) exit 0 ;;
  *) exit 2 ;;
esac
MOCK
cat > "$TEMP/timeout" <<'MOCK'
#!/usr/bin/env bash
shift
exec "$@"
MOCK
cat > "$TEMP/openssl" <<'MOCK'
#!/usr/bin/env bash
connect=''; server_name=''; verify_hostname=''
while (($#)); do
  case "$1" in
    -connect) shift; connect="${1:-}" ;;
    -servername) shift; server_name="${1:-}" ;;
    -verify_hostname) shift; verify_hostname="${1:-}" ;;
  esac
  shift || true
done
host="${connect%:443}"
printf '%s\n' "$host" >> "$H5_OPENSSL_CALL_LOG"
[[ "$connect" == "${host}:443" && "$server_name" == "$host" && "$verify_hostname" == "$host" ]] || {
  echo 'mock OpenSSL options mismatch' >&2
  exit 2
}
case "$host" in
  cert-bad.example.internal) echo 'certificate chain rejected' >&2; exit 1 ;;
  hostname-bad.example.internal) echo 'hostname mismatch' >&2; exit 1 ;;
esac
echo 'Verification: OK'
MOCK
chmod +x "$TEMP/getent" "$TEMP/timeout" "$TEMP/openssl"
export PATH="$TEMP:$PATH"

"$ROOT/probe-private-endpoint.sh" https://dns-ok.example.internal
grep -Fxq dns-ok.example.internal "$H5_OPENSSL_CALL_LOG" || { echo 'FAIL: success case skipped TLS' >&2; exit 1; }
"$ROOT/probe-private-endpoint.sh" https://dns-ok.example.internal:443/

: > "$H5_OPENSSL_CALL_LOG"
if "$ROOT/probe-private-endpoint.sh" https://dns-bad.example.internal >/dev/null 2>&1; then
  echo 'FAIL: DNS failure was accepted' >&2; exit 1
fi
[[ ! -s "$H5_OPENSSL_CALL_LOG" ]] || { echo 'FAIL: TLS ran after DNS failure' >&2; exit 1; }

: > "$H5_OPENSSL_CALL_LOG"
if "$ROOT/probe-private-endpoint.sh" https://cert-bad.example.internal >/dev/null 2>&1; then
  echo 'FAIL: invalid certificate chain was accepted' >&2; exit 1
fi
grep -Fxq cert-bad.example.internal "$H5_OPENSSL_CALL_LOG" || { echo 'FAIL: certificate case did not reach OpenSSL' >&2; exit 1; }

: > "$H5_OPENSSL_CALL_LOG"
if "$ROOT/probe-private-endpoint.sh" https://hostname-bad.example.internal >/dev/null 2>&1; then
  echo 'FAIL: invalid certificate hostname was accepted' >&2; exit 1
fi
grep -Fxq hostname-bad.example.internal "$H5_OPENSSL_CALL_LOG" || { echo 'FAIL: hostname case did not reach OpenSSL' >&2; exit 1; }

: > "$H5_OPENSSL_CALL_LOG"
for invalid_url in \
  http://dns-ok.example.internal \
  https://user@dns-ok.example.internal \
  https://user:password@dns-ok.example.internal \
  https://dns-ok.example.internal:8443 \
  https://dns-ok.example.internal/path \
  https://dns-ok.example.internal/?query=1 \
  https://dns-ok.example.internal/#fragment; do
  if "$ROOT/probe-private-endpoint.sh" "$invalid_url" >/dev/null 2>&1; then
    echo "FAIL: URL inválida aceptada: $invalid_url" >&2; exit 1
  fi
done
[[ ! -s "$H5_OPENSSL_CALL_LOG" ]] || { echo 'FAIL: URL inválida llegó a OpenSSL' >&2; exit 1; }

# Prove this same test harness catches removal of hostname verification.
sed '/-verify_hostname /d' "$ROOT/probe-private-endpoint.sh" > "$TEMP/probe-without-hostname.sh"
chmod +x "$TEMP/probe-without-hostname.sh"
if "$TEMP/probe-without-hostname.sh" https://dns-ok.example.internal >/dev/null 2>&1; then
  echo 'FAIL: test harness accepted a probe without -verify_hostname' >&2; exit 1
fi
echo 'PASS: HTTPS origin, DNS, TLS chain and hostname positive/negative cases'
