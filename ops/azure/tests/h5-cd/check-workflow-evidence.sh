#!/usr/bin/env bash
set -Eeuo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/bin"
export PATH="$fixture/bin:$PATH"
export GITHUB_STEP_SUMMARY="$fixture/summary"
export CANDIDATE_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
printf '{}\n' > "$fixture/package-lock.json"
cat > "$fixture/bin/npm" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${1:-}" == --version ]]; then echo synthetic; exit 0; fi
[[ "$*" == "audit --omit=dev --audit-level=high --json" ]] || exit 65
case "${MOCK_AUDIT:-}" in
  scanner-down) exit 2 ;;
  high) printf '{"metadata":{"vulnerabilities":{"high":1,"critical":0}}}\n'; exit 1 ;;
  missing) exit 0 ;;
  malformed) printf 'invalid JSON\n'; exit 0 ;;
  high-exit-zero) printf '{"metadata":{"vulnerabilities":{"high":1,"critical":0}}}\n'; exit 0 ;;
  clean) printf '{"metadata":{"vulnerabilities":{"high":0,"critical":0}}}\n'; exit 0 ;;
  *) exit 65 ;;
esac
MOCK
cat > "$fixture/bin/curl" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
output=''
url=''
while (($#)); do
  case "$1" in
    --output) shift; output="$1" ;;
    https://*) url="$1" ;;
  esac
  shift
done
if [[ "$url" == */protected ]]; then printf 401; exit 0; fi
if [[ "$url" == */health/ready || "$url" == */health/readiness ]]; then
  printf '{"status":"%s","service":"%s"}\n' "${MOCK_READY_STATUS:-ready}" "${MOCK_READY_SERVICE:-catalog-svc}" > "$output"
else
  printf '{"status":"%s","service":"%s"}\n' "${MOCK_LIVE_STATUS:-ok}" "${MOCK_LIVE_SERVICE:-catalog-svc}" > "$output"
fi
printf 200
MOCK
chmod +x "$fixture/bin/"*
awk '
  /name: Ejecutar auditoría reproducible desde package-lock.json/ { step=1; next }
  step && /^        run: \|/ { body=1; next }
  body && /^      - name: / { exit }
  body { sub(/^          /, ""); print }
' "$root/.github/workflows/cd-services-azure.yml" > "$fixture/audit.sh"
grep -q "npm audit --omit=dev --audit-level=high --json" "$fixture/audit.sh"
cd "$fixture" || exit 1
MOCK_AUDIT=clean bash "$fixture/audit.sh" >/dev/null
grep -q '"critical":0' "$fixture/h5-security-evidence/npm-audit.json"
failures=0
assert_rejected() {
  local case_id="$1"
  shift
  if "$@" > "$fixture/case.log" 2>&1; then
    printf "%s FAIL accepted invalid fixture\n" "$case_id"
    failures=1
  else
    printf "%s PASS rejected invalid fixture\n" "$case_id"
  fi
}
assert_rejected CD-06-HIGH env MOCK_AUDIT=high bash "$fixture/audit.sh"
assert_rejected CD-06-SCANNER env MOCK_AUDIT=scanner-down bash "$fixture/audit.sh"
assert_rejected CD-06-MISSING env MOCK_AUDIT=missing bash "$fixture/audit.sh"
assert_rejected CD-06-MALFORMED env MOCK_AUDIT=malformed bash "$fixture/audit.sh"
assert_rejected CD-06-HIGH-EXIT-ZERO env MOCK_AUDIT=high-exit-zero bash "$fixture/audit.sh"
assert_rejected CD-07-WRONG-SERVICE env MOCK_LIVE_STATUS=ok MOCK_LIVE_SERVICE=unrelated-fixture \
  SMOKE_URL=https://fixture.invalid SMOKE_PROTECTED_PATH=/protected SMOKE_MAX_ATTEMPTS=1 \
  bash "$root/ops/azure/container-apps/smoke-service.sh" catalog-svc
assert_rejected CD-07-WRONG-LIVE-STATUS env MOCK_LIVE_STATUS=not_ready MOCK_LIVE_SERVICE=catalog-svc \
  SMOKE_URL=https://fixture.invalid SMOKE_PROTECTED_PATH=/protected SMOKE_MAX_ATTEMPTS=1 \
  bash "$root/ops/azure/container-apps/smoke-service.sh" catalog-svc
assert_rejected CD-07-WRONG-READY-STATUS env MOCK_LIVE_STATUS=ok MOCK_LIVE_SERVICE=catalog-svc \
  MOCK_READY_STATUS=not_ready MOCK_READY_SERVICE=catalog-svc \
  SMOKE_URL=https://fixture.invalid SMOKE_PROTECTED_PATH=/protected SMOKE_MAX_ATTEMPTS=1 \
  bash "$root/ops/azure/container-apps/smoke-service.sh" catalog-svc
if ! env MOCK_LIVE_STATUS=ok MOCK_LIVE_SERVICE=catalog-svc MOCK_READY_STATUS=ready MOCK_READY_SERVICE=catalog-svc \
  SMOKE_URL=https://fixture.invalid SMOKE_PROTECTED_PATH=/protected SMOKE_MAX_ATTEMPTS=1 \
  bash "$root/ops/azure/container-apps/smoke-service.sh" catalog-svc > "$fixture/pass.log" 2>&1; then
  printf "CD-07-HEALTHY FAIL rejected valid fixture\n"
  failures=1
else
  printf "CD-07-HEALTHY PASS accepted valid fixture\n"
fi
exit "$failures"
