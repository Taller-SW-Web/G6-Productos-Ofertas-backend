#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT
cat > "$TEMP/curl" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
output=''
dump_header=''
url=''
method='GET'
req_cid=''
[[ -z "${CURL_ARGS_LOG:-}" ]] || printf '%s\n' "$*" >> "$CURL_ARGS_LOG"
while (($#)); do
  case "$1" in
    --output) shift; output="$1" ;;
    --dump-header) shift; dump_header="$1" ;;
    --request) shift; method="$1" ;;
    --header)
      shift
      if [[ "${1,,}" == x-correlation-id:* ]]; then
        req_cid="${1#*: }"
      fi
      ;;
    https://*) url="$1" ;;
  esac
  shift
done
[[ -z "${CURL_LOG:-}" ]] || printf '%s\n' "$url" >> "$CURL_LOG"
if [[ -n "$dump_header" ]]; then
  printf 'HTTP/1.1 401 Unauthorized\r\n' > "$dump_header"
  if [[ -n "$req_cid" && "${MOCK_APIM_OMIT_CID:-false}" != true ]]; then
    printf 'x-correlation-id: %s\r\n' "$req_cid" >> "$dump_header"
  fi
fi
if [[ "$url" == https://apim-g6-productos-chile.azure-api.net/* ]]; then
  printf '%s' "${MOCK_APIM_STATUS:-401}"
  exit 0
fi
if [[ "$url" == https://api-gateway.calmgrass-aec0b33c.chilecentral.azurecontainerapps.io/* ]]; then
  printf '%s' "${MOCK_DIRECT_GW_STATUS:-403}"
  exit 0
fi
if [[ -n "$output" && "$output" != /dev/null ]]; then
  base_service="${MOCK_HEALTH_SERVICE:-catalog-svc}"
  if [[ "$url" == */health/ready || "$url" == */health/readiness ]]; then
    body_service="${MOCK_READINESS_SERVICE:-$base_service}"
    body_status="${MOCK_READINESS_STATUS:-ready}"
    if [[ -n "${MOCK_READINESS_EXTRA:-}" ]]; then
      printf '{"status":"%s","service":"%s",%s}' "$body_status" "$body_service" "$MOCK_READINESS_EXTRA" > "$output"
    else
      printf '{"status":"%s","service":"%s"}' "$body_status" "$body_service" > "$output"
    fi
  else
    body_service="${MOCK_LIVENESS_SERVICE:-$base_service}"
    body_status="${MOCK_LIVENESS_STATUS:-ok}"
    printf '{"status":"%s","service":"%s"}' "$body_status" "$body_service" > "$output"
  fi
fi
if [[ "$url" == *'/private/read' || "$url" == *'/api/v1/promociones/evaluar' ]]; then
  if [[ "$method" == POST ]]; then printf '%s' "${MOCK_POST_STATUS:-401}"; else printf '401'; fi
  exit 0
fi
if [[ "${MOCK_READINESS_FAILURE:-false}" == true && ( "$url" == */health/ready || "$url" == */health/readiness ) ]]; then
  printf '503'
elif [[ "${MOCK_LIVENESS_FAILURE:-false}" == true && "$url" == */health ]]; then
  printf '503'
else
  printf '200'
fi
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

# Verify contract compatibility across all nine applications (8 microservices + API Gateway).
for spec in \
  'api-gateway||GET|/private/read|' \
  'bulk-svc|/health/readiness|GET|/private/read|"reason":"ok"' \
  'catalog-svc|/health/ready|GET|/private/read|' \
  'combos-svc|/health/ready|GET|/private/read|"dependencies":{"postgres":"ok"}' \
  'inventory-svc|/health/readiness|GET|/private/read|' \
  'price-audit-svc|/health/ready|GET|/private/read|' \
  'pricing-svc|/health/ready|GET|/private/read|' \
  'promotions-svc|/health/ready|POST|/api/v1/promociones/evaluar|"dependencies":{"database":"up","broker":"disabled"}' \
  'taxonomy-svc|/health/ready|GET|/private/read|'; do
  IFS='|' read -r app_service expected_ready_path app_method app_protected app_extra <<< "$spec"
  app_urls="$TEMP/urls-${app_service}.log"
  rm -f "$app_urls"
  PATH="$TEMP:$PATH" CURL_LOG="$app_urls" MOCK_HEALTH_SERVICE="$app_service" MOCK_READINESS_EXTRA="$app_extra" \
    SMOKE_URL='https://example.invalid' SMOKE_PROTECTED_PATH="$app_protected" SMOKE_PROTECTED_METHOD="$app_method" \
    SMOKE_MAX_ATTEMPTS=1 bash "$ROOT/ops/azure/container-apps/smoke-service.sh" "$app_service" > "$TEMP/matrix-${app_service}.log"
  grep -Fxq 'https://example.invalid/health' "$app_urls"
  if [[ -n "$expected_ready_path" ]]; then
    grep -Fxq "https://example.invalid${expected_ready_path}" "$app_urls"
  else
    if grep -Eq '/health/(ready|readiness)$' "$app_urls"; then
      echo "FAIL: $app_service consultó readiness inexistente" >&2; exit 1
    fi
  fi
  grep -Fxq "https://example.invalid${app_protected}" "$app_urls"
done
echo 'PASS: compatibilidad de salud e identidad verificada para las nueve aplicaciones'

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

# Negative CD-07 cases: HTTP 200 with healthy status and wrong service identity.
if PATH="$TEMP:$PATH" SMOKE_URL='https://example.invalid' SMOKE_PROTECTED_PATH='/private/read' \
  SMOKE_MAX_ATTEMPTS=1 MOCK_LIVENESS_STATUS=ok MOCK_LIVENESS_SERVICE=pricing-svc \
  bash "$ROOT/ops/azure/container-apps/smoke-service.sh" catalog-svc > "$TEMP/wrong-live-service.log" 2>&1; then
  echo 'FAIL: liveness 200 ok de otro servicio fue aceptado' >&2; exit 1
fi
grep -Fq 'FALLO de liveness: catalog-svc' "$TEMP/wrong-live-service.log"

if PATH="$TEMP:$PATH" SMOKE_URL='https://example.invalid' SMOKE_PROTECTED_PATH='/private/read' \
  SMOKE_MAX_ATTEMPTS=1 MOCK_READINESS_STATUS=ready MOCK_READINESS_SERVICE=pricing-svc \
  bash "$ROOT/ops/azure/container-apps/smoke-service.sh" catalog-svc > "$TEMP/wrong-ready.log" 2>&1; then
  echo 'FAIL: readiness 200 ready de otro servicio fue aceptado' >&2; exit 1
fi
grep -Fq 'FALLO de readiness: catalog-svc' "$TEMP/wrong-ready.log"
echo 'PASS: HTTP 200 saludable con identidad de otro servicio bloquea liveness y readiness'

# Negative CD-07 cases: HTTP 200 with correct service identity and wrong status.
for bad_live_status in not_ready error ready degraded; do
  if PATH="$TEMP:$PATH" SMOKE_URL='https://example.invalid' SMOKE_PROTECTED_PATH='/private/read' \
    SMOKE_MAX_ATTEMPTS=1 MOCK_HEALTH_SERVICE=catalog-svc MOCK_LIVENESS_STATUS="$bad_live_status" \
    bash "$ROOT/ops/azure/container-apps/smoke-service.sh" catalog-svc > "$TEMP/bad-live-${bad_live_status}.log" 2>&1; then
    echo "FAIL: liveness 200 con status=$bad_live_status e identidad correcta fue aceptado" >&2; exit 1
  fi
  grep -Fq 'FALLO de liveness: catalog-svc' "$TEMP/bad-live-${bad_live_status}.log"
done

for bad_ready_status in not_ready error ok degraded; do
  if PATH="$TEMP:$PATH" SMOKE_URL='https://example.invalid' SMOKE_PROTECTED_PATH='/private/read' \
    SMOKE_MAX_ATTEMPTS=1 MOCK_HEALTH_SERVICE=inventory-svc MOCK_READINESS_STATUS="$bad_ready_status" \
    bash "$ROOT/ops/azure/container-apps/smoke-service.sh" inventory-svc > "$TEMP/bad-ready-${bad_ready_status}.log" 2>&1; then
    echo "FAIL: readiness 200 con status=$bad_ready_status e identidad correcta fue aceptado" >&2; exit 1
  fi
  grep -Fq 'FALLO de readiness: inventory-svc' "$TEMP/bad-ready-${bad_ready_status}.log"
done
echo 'PASS: HTTP 200 con identidad correcta y estado incorrecto bloquea liveness y readiness'

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

service=api-gateway
target='ghcr.io/taller-sw-web/g6-productos-ofertas-backend/api-gateway@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
resource_id='/subscriptions/fef42188-accd-4470-ae88-78f583eb4906/resourceGroups/rg-g6-aca-chile/providers/Microsoft.App/containerApps/api-gateway'
label_url=https://api-gateway---g5-h5.internal.chilecentral.azurecontainerapps.io
jq -n --arg service "$service" --arg run "$run_id" --arg target "$target" --arg id "$resource_id" --arg url "$label_url" '{destination:"chile-shared",github_environment:"azure-h5-chile",aca_environment:"env-g6-phase1-chile",service:$service,workflow_run_id:$run,app_resource_id:$id,target:$target,digest_candidate:($target|split("@")[1]),served_digest:($target|split("@")[1]),served_revision:"api-gateway--g5candidate",route_profile:"g5-labelled",route_mode:"revision_label",g5_label:"g5-h5",g5_label_url:$url,marketplace_revision:"api-gateway--g3sec1125a",marketplace_traffic_weight:100}' > "$receipt"
export SMOKE_URL="$label_url" SMOKE_PROTECTED_PATH=/private/read H5_GATEWAY_ROUTE_PROFILE=g5-labelled MOCK_HEALTH_SERVICE=api-gateway
rm -f "$CURL_LOG"
PATH="$TEMP:$PATH" bash "$ROOT/ops/azure/container-apps/smoke-service.sh" api-gateway > "$TEMP/g5-label-pass.log"
grep -Fq 'PASS ruta protegida sin credenciales' "$TEMP/g5-label-pass.log"
[[ -s "$CURL_LOG" ]] || { echo 'FAIL: G5 labelled URL no reached HTTP checks' >&2; exit 1; }
jq '.marketplace_traffic_weight=50' "$receipt" > "$receipt.tmp" && mv "$receipt.tmp" "$receipt"
expect_no_http 'Marketplace route not at 100% in G5 labelled receipt'

# Case-insensitive ARM resource ID normalization + required negative receipt checks (both profiles).
service=price-audit-svc
origin=https://price-audit-svc.internal.chilecentral.azurecontainerapps.io
target='ghcr.io/taller-sw-web/g6-productos-ofertas-backend/price-audit-svc@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
resource_id='/subscriptions/fef42188-accd-4470-ae88-78f583eb4906/resourceGroups/rg-g6-aca-chile/providers/Microsoft.App/containerapps/price-audit-svc'
export SMOKE_URL="$origin" SMOKE_PROTECTED_PATH=/private/read H5_GATEWAY_ROUTE_PROFILE=standard MOCK_HEALTH_SERVICE=price-audit-svc
make_receipt chile-shared azure-h5-chile price-audit-svc 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
rm -f "$CURL_LOG"
PATH="$TEMP:$PATH" bash "$ROOT/ops/azure/container-apps/smoke-service.sh" price-audit-svc > "$TEMP/case-pass.log"
[[ -s "$CURL_LOG" ]] || { echo 'FAIL: lowercase containerapps ARM resource ID was rejected' >&2; exit 1; }
jq '.app_resource_id="/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-g6-aca-chile/providers/Microsoft.App/containerapps/price-audit-svc"' "$receipt" > "$receipt.tmp" && mv "$receipt.tmp" "$receipt"
expect_no_http 'other subscription'
make_receipt chile-shared azure-h5-chile price-audit-svc 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
jq '.app_resource_id="/subscriptions/fef42188-accd-4470-ae88-78f583eb4906/resourceGroups/rg-other/providers/Microsoft.App/containerapps/price-audit-svc"' "$receipt" > "$receipt.tmp" && mv "$receipt.tmp" "$receipt"
expect_no_http 'other resource group'
make_receipt chile-shared azure-h5-chile price-audit-svc 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
jq '.app_resource_id="/subscriptions/fef42188-accd-4470-ae88-78f583eb4906/resourceGroups/rg-g6-aca-chile/providers/Microsoft.App/containerapps/other-svc"' "$receipt" > "$receipt.tmp" && mv "$receipt.tmp" "$receipt"
expect_no_http 'other container app'
make_receipt chile-shared azure-h5-chile price-audit-svc 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
jq '.workflow_run_id="11111"' "$receipt" > "$receipt.tmp" && mv "$receipt.tmp" "$receipt"
expect_no_http 'other workflow run'

service=api-gateway
target='ghcr.io/taller-sw-web/g6-productos-ofertas-backend/api-gateway@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
resource_id='/subscriptions/fef42188-accd-4470-ae88-78f583eb4906/resourceGroups/rg-g6-aca-chile/providers/Microsoft.App/containerapps/api-gateway'
jq -n --arg service "$service" --arg run "$run_id" --arg target "$target" --arg id "$resource_id" --arg url "$label_url" '{destination:"chile-shared",github_environment:"azure-h5-chile",aca_environment:"env-g6-phase1-chile",service:$service,workflow_run_id:$run,app_resource_id:$id,target:$target,digest_candidate:($target|split("@")[1]),served_digest:($target|split("@")[1]),served_revision:"api-gateway--g5candidate",route_profile:"g5-labelled",route_mode:"revision_label",g5_label:"g5-h5",g5_label_url:$url,marketplace_revision:"api-gateway--g3sec1125a",marketplace_traffic_weight:100}' > "$receipt"
export SMOKE_URL="$label_url" SMOKE_PROTECTED_PATH=/private/read H5_GATEWAY_ROUTE_PROFILE=g5-labelled MOCK_HEALTH_SERVICE=api-gateway
rm -f "$CURL_LOG"
PATH="$TEMP:$PATH" bash "$ROOT/ops/azure/container-apps/smoke-service.sh" api-gateway > "$TEMP/g5-case-pass.log"
[[ -s "$CURL_LOG" ]] || { echo 'FAIL: lowercase containerapps ARM resource ID rejected for g5-labelled' >&2; exit 1; }
echo 'PASS: G5 label smoke uses its isolated URL and requires the same-run Marketplace 100% receipt'

# Modalidad B Gateway standard: digest/salud en recibo, health interno autorizado, API vía APIM y 403 directo anti-bypass.
service=api-gateway
gw_ext='https://api-gateway.calmgrass-aec0b33c.chilecentral.azurecontainerapps.io'
gw_int='https://api-gateway.internal.calmgrass-aec0b33c.chilecentral.azurecontainerapps.io'
target='ghcr.io/taller-sw-web/g6-productos-ofertas-backend/api-gateway@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
resource_id='/subscriptions/fef42188-accd-4470-ae88-78f583eb4906/resourceGroups/rg-g6-aca-chile/providers/Microsoft.App/containerApps/api-gateway'
make_gw_modb_receipt() {
  jq -n --arg run "$run_id" --arg id "$resource_id" --arg ext "$gw_ext" --arg int "$gw_int" --arg target "$target" '{
    destination:"chile-shared",
    github_environment:"azure-h5-chile",
    aca_environment:"env-g6-phase1-chile",
    service:"api-gateway",
    workflow_run_id:$run,
    app_resource_id:$id,
    origin_https:$ext,
    internal_origin_https:$int,
    modalidad_b:true,
    preserved_labels:[{"label":"g5-h5","revisionName":"api-gateway--0000002","weight":0}],
    target:$target,
    digest_candidate:($target|split("@")[1]),
    served_digest:($target|split("@")[1]),
    served_revision:"api-gateway--0000004",
    served_health:"Healthy",
    traffic_weight:100,
    route_profile:"standard"
  }' > "$receipt"
}
make_gw_modb_receipt
export SMOKE_URL="$gw_ext" SMOKE_PROTECTED_PATH='/api/v1/productos/administracion' H5_GATEWAY_ROUTE_PROFILE=standard MOCK_HEALTH_SERVICE=api-gateway
rm -f "$CURL_LOG"
PATH="$TEMP:$PATH" bash "$ROOT/ops/azure/container-apps/smoke-service.sh" api-gateway > "$TEMP/gw-modb-pass.log" 2>&1 || { cat "$TEMP/gw-modb-pass.log"; exit 1; }
grep -Fq 'PASS recibo Modalidad B:' "$TEMP/gw-modb-pass.log"
grep -Fq 'PASS /health HTTP 200' "$TEMP/gw-modb-pass.log"
grep -Fq 'PASS rechazo anónimo en APIM: HTTP 401' "$TEMP/gw-modb-pass.log"
grep -Fq 'PASS anti-bypass Modalidad B: acceso directo rechazado HTTP 403' "$TEMP/gw-modb-pass.log"
grep -Fxq "${gw_int}/health" "$CURL_LOG"
grep -Fxq 'https://apim-g6-productos-chile.azure-api.net/api/v1/productos/administracion' "$CURL_LOG"
grep -Fxq "${gw_ext}/health" "$CURL_LOG"
grep -Fxq "${gw_ext}/api/v1/productos/administracion" "$CURL_LOG"
if PATH="$TEMP:$PATH" MOCK_DIRECT_GW_STATUS=200 bash "$ROOT/ops/azure/container-apps/smoke-service.sh" api-gateway > "$TEMP/gw-modb-bypass.log" 2>&1; then
  echo 'FAIL: Modalidad B aceptó acceso directo HTTP 200 (bypass)' >&2; exit 1
fi
grep -Fq 'FALLO anti-bypass Modalidad B' "$TEMP/gw-modb-bypass.log"
if PATH="$TEMP:$PATH" MOCK_APIM_OMIT_CID=true bash "$ROOT/ops/azure/container-apps/smoke-service.sh" api-gateway > "$TEMP/gw-modb-nocid.log" 2>&1; then
  echo 'FAIL: Modalidad B aceptó respuesta APIM sin x-correlation-id' >&2; exit 1
fi
if PATH="$TEMP:$PATH" MOCK_LIVENESS_FAILURE=true bash "$ROOT/ops/azure/container-apps/smoke-service.sh" api-gateway > "$TEMP/gw-modb-unhealthy.log" 2>&1; then
  echo 'FAIL: Modalidad B aceptó health interno 503' >&2; exit 1
fi
echo 'PASS: Gateway Modalidad B acredita digest/salud en recibo, health interno autorizado, API vía APIM con correlación y 403 directo anti-bypass'
