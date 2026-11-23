#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT

cat > "$TEMP/getent" <<'MOCK'
#!/usr/bin/env bash
[[ "${2:-}" == dns-ok.example.internal ]]
MOCK
cat > "$TEMP/timeout" <<'MOCK'
#!/usr/bin/env bash
shift
exec "$@"
MOCK
cat > "$TEMP/openssl" <<'MOCK'
#!/usr/bin/env bash
if [[ "${*: -1}" == *tls-bad.example.internal* ]]; then
  echo 'Verification: self-signed certificate' >&2
  exit 1
fi
echo 'Verification: OK'
MOCK
chmod +x "$TEMP/getent" "$TEMP/timeout" "$TEMP/openssl"

PATH="$TEMP:$PATH" "$ROOT/probe-private-endpoint.sh" https://dns-ok.example.internal
if PATH="$TEMP:$PATH" "$ROOT/probe-private-endpoint.sh" http://dns-ok.example.internal >/dev/null 2>&1; then
  echo 'FAIL: HTTP URL was accepted' >&2; exit 1
fi
if PATH="$TEMP:$PATH" "$ROOT/probe-private-endpoint.sh" https://dns-bad.example.internal >/dev/null 2>&1; then
  echo 'FAIL: unresolved hostname was accepted' >&2; exit 1
fi
if PATH="$TEMP:$PATH" "$ROOT/probe-private-endpoint.sh" https://tls-bad.example.internal >/dev/null 2>&1; then
  echo 'FAIL: invalid TLS was accepted' >&2; exit 1
fi
echo 'PASS: HTTPS validation, DNS failure and TLS failure cases'
