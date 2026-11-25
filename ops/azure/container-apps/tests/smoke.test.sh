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
method='GET'
[[ -z "${CURL_ARGS_LOG:-}" ]] || printf '%s\n' "$*" >> "$CURL_ARGS_LOG"
while (($#)); do
  case "$1" in
    --output) shift; output="$1" ;;
    --request) shift; method="$1" ;;
    https://*) url="$1" ;;
  esac
  shift
done
[[ -z "${CURL_LOG:-}" ]] || printf '%s\n' "$url" >> "$CURL_LOG"
if [[ -n "$output" && "$output" != /dev/null ]]; then
  service="${MOCK_HEALTH_SERVICE:-catalog-svc}"
  if [[ "$url" == */health/ready || "$url" == */health/readiness ]]; then
    service="${MOCK_READINESS_SERVICE:-$service}"
  fi
  printf '{"status":"ready","service":"%s"}' "$service" > "$output"
fi
if [[ "$url" == *'/private/read' || "$url" == *'/api/v1/promociones/evaluar' ]]; then
  if [[ "$method" == POST ]]; then printf '%s' "${MOCK_POST_STATUS:-401}"; else printf '401'; fi
  exit 0
fi
if [[ "${MOCK_READINESS_FAILURE:-false}" == true && "$url" == */health/ready || "${MOCK_READINESS_FAILURE:-false}" == true && "$url" == */health/readiness ]]; then printf '503'; else printf '200'; fi
MOCK
chmod +x "$TEMP/curl"
command -v jq >/dev/null || { echo 'FAIL: las pruebas de smoke requieren jq' >&2; exit 1; }

export CURL_ARGS_LOG="$TEMP/default-get-args.log"
PATH="$TEMP:$PATH" SMOKE_URL='https://example.invalid' SMOKE_PROTECTED_PATH='/private/read' \
  SMOKE_MAX_ATTEMPTS=1 bash "$ROOT/ops/azure/container-apps/smoke-service.sh" catalog-svc > "$TEMP/pass.log"
grep -Fq 'PASS /health HTTP 200' "$TEMP/pass.log"
grep -Fq 'PASS /health/ready HTTP 200' "$TEMP/pass.log"
grep -Fq 'PASS ruta protegida sin credenciales: HTTP 401' "$TEMP/pass.log"
if grep -q -- '--request POST' "$CURL_ARGS_LOG"; then
  echo 'FAIL: servicio existente dejó de utilizar el GET predeterminado' >&2; exit 1
fi
echo 'PASS: liveness, readiness y rechazo 401 sin token'

# Existing services keep GET by default; Promotions uses a bodyless-auth-free POST guard probe.
export CURL_ARGS_LOG="$TEMP/curl-args.log"
export MOCK_HEALTH_SERVICE=promotions-svc
PATH="$TEMP:$PATH" SMOKE_URL='https://example.invalid' SMOKE_PROTECTED_PATH='/api/v1/promociones/evaluar' \
  SMOKE_PROTECTED_METHOD=POST SMOKE_MAX_ATTEMPTS=1 bash "$ROOT/ops/azure/container-apps/smoke-service.sh" promotions-svc > "$TEMP/post-pass.log"
grep -Fq 'PASS ruta protegida sin credenciales: HTTP 401' "$TEMP/post-pass.log"
grep -Fq -- '--request POST --header Content-Type: application/json --data {}' "$CURL_ARGS_LOG"
if grep -qi 'authorization' "$CURL_ARGS_LOG"; then
  echo 'FAIL: el smoke POST anónimo envió Authorization' >&2; exit 1
fi
echo 'PASS: Promotions POST anónimo envía solo JSON mínimo y exige HTTP 401'

for response in 200 400 403; do
  if PATH="$TEMP:$PATH" SMOKE_URL='https://example.invalid' SMOKE_PROTECTED_PATH='/api/v1/promociones/evaluar' \
    SMOKE_PROTECTED_METHOD=POST SMOKE_MAX_ATTEMPTS=1 MOCK_POST_STATUS="$response" \
    bash "$ROOT/ops/azure/container-apps/smoke-service.sh" promotions-svc > "$TEMP/post-$response.log" 2>&1; then
    echo "FAIL: POST anónimo HTTP $response debe bloquear el smoke" >&2; exit 1
  fi
done
echo 'PASS: Promotions POST falla ante 200, 400 o 403'

if PATH="$TEMP:$PATH" SMOKE_URL='https://example.invalid' SMOKE_PROTECTED_PATH='/private/read' \
  SMOKE_PROTECTED_METHOD=POST SMOKE_MAX_ATTEMPTS=1 bash "$ROOT/ops/azure/container-apps/smoke-service.sh" catalog-svc > "$TEMP/post-unallowed.log" 2>&1; then
  echo 'FAIL: POST en servicio/ruta no permitidos fue aceptado' >&2; exit 1
fi
grep -Fq 'POST protegido solo está permitido para Promotions evaluarPromociones' "$TEMP/post-unallowed.log"
if PATH="$TEMP:$PATH" SMOKE_URL='https://example.invalid' SMOKE_PROTECTED_PATH='/private/read' \
  SMOKE_PROTECTED_METHOD=PATCH SMOKE_MAX_ATTEMPTS=1 bash "$ROOT/ops/azure/container-apps/smoke-service.sh" catalog-svc > "$TEMP/invalid-method.log" 2>&1; then
  echo 'FAIL: método inválido fue aceptado' >&2; exit 1
fi
grep -Fq 'Método protegido no admitido' "$TEMP/invalid-method.log"
echo 'PASS: POST fuera de la única ruta autorizada y métodos inválidos son rechazados'
unset MOCK_HEALTH_SERVICE

if PATH="$TEMP:$PATH" SMOKE_URL='https://example.invalid' SMOKE_PROTECTED_PATH='/private/read' \
  SMOKE_MAX_ATTEMPTS=1 MOCK_READINESS_SERVICE=pricing-svc \
  bash "$ROOT/ops/azure/container-apps/smoke-service.sh" catalog-svc > "$TEMP/wrong-ready.log" 2>&1; then
  echo 'FAIL: readiness 200 de otro servicio fue aceptado' >&2; exit 1
fi
grep -Fq 'FALLO de readiness: catalog-svc' "$TEMP/wrong-ready.log"
echo 'PASS: readiness 200 con identidad de otro servicio bloquea el smoke'

if PATH="$TEMP:$PATH" SMOKE_URL='https://example.invalid' SMOKE_PROTECTED_PATH='/private/read' SMOKE_MAX_ATTEMPTS=1 MOCK_READINESS_FAILURE=true MOCK_HEALTH_SERVICE=inventory-svc \
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
