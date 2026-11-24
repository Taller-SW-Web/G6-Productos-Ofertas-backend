#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT
cat > "$TEMP/curl" <<'MOCK'
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
[[ -z "${CURL_LOG:-}" ]] || printf '%s\n' "$url" >> "$CURL_LOG"
if [[ -n "$output" && "$output" != /dev/null ]]; then printf '{"status":"ready"}' > "$output"; fi
if [[ "$url" == *'/private/read' ]]; then printf '401'; exit 0; fi
if [[ "${MOCK_READINESS_FAILURE:-false}" == true && "$url" == */health/ready || "${MOCK_READINESS_FAILURE:-false}" == true && "$url" == */health/readiness ]]; then printf '503'; else printf '200'; fi
MOCK
chmod +x "$TEMP/curl"
if ! command -v jq >/dev/null 2>&1; then
  cat > "$TEMP/jq" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
file="${@: -1}"
node - "$file" <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
process.exit(value !== null && typeof value === 'object' ? 0 : 1);
NODE
MOCK
  chmod +x "$TEMP/jq"
fi

PATH="$TEMP:$PATH" SMOKE_URL='https://example.invalid' SMOKE_PROTECTED_PATH='/private/read' \
  SMOKE_MAX_ATTEMPTS=1 bash "$ROOT/ops/azure/container-apps/smoke-service.sh" catalog-svc > "$TEMP/pass.log"
grep -Fq 'PASS /health HTTP 200' "$TEMP/pass.log"
grep -Fq 'PASS /health/ready HTTP 200' "$TEMP/pass.log"
grep -Fq 'PASS ruta protegida sin credenciales: HTTP 401' "$TEMP/pass.log"
echo 'PASS: liveness, readiness y rechazo 401 sin token'

if PATH="$TEMP:$PATH" SMOKE_URL='https://example.invalid' SMOKE_PROTECTED_PATH='/private/read' SMOKE_MAX_ATTEMPTS=1 MOCK_READINESS_FAILURE=true \
  bash "$ROOT/ops/azure/container-apps/smoke-service.sh" inventory-svc > "$TEMP/fail.log" 2>&1; then
  echo 'FAIL: el servicio con readiness 503 debe bloquear smoke' >&2; exit 1
fi
grep -Fq 'FALLO de readiness: inventory-svc' "$TEMP/fail.log"
echo 'PASS: fallo real del servicio (readiness 503) bloquea el smoke'

if PATH="$TEMP:$PATH" bash "$ROOT/ops/azure/container-apps/smoke-service.sh" taxonomy-svc > "$TEMP/no-url.log" 2>&1; then
  echo 'FAIL: ausencia de URL debe bloquear el smoke' >&2; exit 1
fi
grep -Fq 'BLOQUEADO: falta AZURE_SMOKE_URL_TAXONOMY_SVC' "$TEMP/no-url.log"
echo 'PASS: ausencia de URL bloquea el smoke y el job'

if PATH="$TEMP:$PATH" SMOKE_URL='https://example.invalid' SMOKE_MAX_ATTEMPTS=1 \
  bash "$ROOT/ops/azure/container-apps/smoke-service.sh" taxonomy-svc > "$TEMP/no-protected.log" 2>&1; then
  echo 'FAIL: ruta protegida ausente debe bloquear el smoke' >&2; exit 1
fi
grep -Fq 'BLOQUEADO: falta AZURE_SMOKE_PROTECTED_TAXONOMY_SVC' "$TEMP/no-protected.log"
echo 'PASS: ruta protegida no configurada bloquea el smoke y el job'

if PATH="$TEMP:$PATH" SMOKE_URL='http://example.invalid' bash "$ROOT/ops/azure/container-apps/smoke-service.sh" catalog-svc >/dev/null 2>&1; then
  echo 'FAIL: URL no HTTPS aceptada' >&2; exit 1
fi
echo 'PASS: URL no HTTPS rechazada'

# Chile shared smoke is authorized only by the same-run receipt and exact ACA FQDN.
service=catalog-svc
run_id=98765
origin=https://catalog-svc.internal.chilecentral.azurecontainerapps.io
target='ghcr.io/taller-sw-web/g6-productos-ofertas-backend/catalog-svc@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
resource_id='/subscriptions/fef42188-accd-4470-ae88-78f583eb4906/resourceGroups/rg-g6-aca-chile/providers/Microsoft.App/containerApps/catalog-svc'
receipt="$TEMP/catalog.receipt"
make_receipt() {
  jq -n --arg service "$service" --arg run "$run_id" --arg origin "$origin" --arg target "$target" --arg id "$resource_id" --arg dest "${1:-chile-shared}" --arg env "${2:-azure-h5-chile}" --arg receipt_service "${3:-catalog-svc}" --arg digest "${4:-sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb}" --arg revision "${5:-catalog-svc--rev-1}" '{destination:$dest,github_environment:$env,aca_environment:"env-g6-phase1-chile",service:$receipt_service,workflow_run_id:$run,app_resource_id:$id,origin_https:$origin,target:$target,digest_candidate:($target|split("@")[1]),served_digest:$digest,served_revision:$revision,traffic_weight:100}' > "$receipt"
}
make_receipt
export CURL_LOG="$TEMP/curl.log" SMOKE_URL="$origin" SMOKE_PROTECTED_PATH=/private/read SMOKE_MAX_ATTEMPTS=1 SMOKE_RECEIPT="$receipt" GITHUB_RUN_ID="$run_id" H5_DEPLOY_DESTINATION=chile-shared H5_DEPLOY_ENVIRONMENT=azure-h5-chile
expect_no_http() {
  rm -f "$CURL_LOG"
  if PATH="$TEMP:$PATH" bash "$ROOT/ops/azure/container-apps/smoke-service.sh" "$service" > "$TEMP/chile-fail.log" 2>&1; then echo "FAIL: Chile smoke accepted $1" >&2; exit 1; fi
  [[ ! -e "$CURL_LOG" ]] || { echo "FAIL: Chile smoke sent HTTP before rejecting $1" >&2; exit 1; }
}
make_receipt chile-shared azure-h5-chile catalog-svc
SMOKE_URL=https://wrong.environment.invalid expect_no_http 'origin from another Environment'
make_receipt chile-shared azure-h5-chile pricing-svc
SMOKE_URL="$origin" expect_no_http 'receipt from another service'
make_receipt chile-shared azure-h5-chile catalog-svc
origin=https://gateway.example.invalid
make_receipt chile-shared azure-h5-chile catalog-svc
SMOKE_URL=https://catalog-svc.internal.chilecentral.azurecontainerapps.io expect_no_http 'FQDN for another ACA service'
origin=https://catalog-svc.internal.chilecentral.azurecontainerapps.io
make_receipt chile-shared azure-h5-chile catalog-svc
unset SMOKE_RECEIPT
expect_no_http 'missing receipt'
export SMOKE_RECEIPT="$receipt"
make_receipt chile-shared azure-h5-chile catalog-svc sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
expect_no_http 'incorrect served digest'
make_receipt chile-shared azure-h5-chile catalog-svc
jq '.traffic_weight=50' "$receipt" > "$receipt.tmp" && mv "$receipt.tmp" "$receipt"
expect_no_http 'inconsistent traffic receipt'
make_receipt chile-shared azure-h5-chile catalog-svc
rm -f "$CURL_LOG"
PATH="$TEMP:$PATH" bash "$ROOT/ops/azure/container-apps/smoke-service.sh" "$service" > "$TEMP/chile-pass.log"
[[ -s "$CURL_LOG" ]] || { echo 'FAIL: exact same-run Chile receipt did not reach HTTP checks' >&2; exit 1; }
grep -Fq 'PASS ruta protegida sin credenciales' "$TEMP/chile-pass.log"
echo 'PASS: Chile smoke validates same-run receipt, internal ACA FQDN, service and digest before HTTP'
