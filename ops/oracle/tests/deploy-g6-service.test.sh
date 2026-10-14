#!/usr/bin/env bash
set -Eeuo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
readonly TEMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEMP_ROOT"' EXIT
readonly STAGED_OPS="${TEMP_ROOT}/opt/g6-productos-ofertas/lib"
readonly MOCK_BIN="${TEMP_ROOT}/bin"
readonly STATE_ROOT="${TEMP_ROOT}/var/lib"
readonly IMAGE_SHA=0123456789012345678901234567890123456789
readonly NEXT_SHA=abcdefabcdefabcdefabcdefabcdefabcdefabcd
readonly INVENTORY_IMAGE="ghcr.io/taller-sw-web/g6-productos-ofertas-backend/inventory-svc:${IMAGE_SHA}"
readonly INVENTORY_NEXT_IMAGE="ghcr.io/taller-sw-web/g6-productos-ofertas-backend/inventory-svc:${NEXT_SHA}"
readonly CATALOG_IMAGE="ghcr.io/taller-sw-web/g6-productos-ofertas-backend/catalog-svc:${IMAGE_SHA}"
readonly CATALOG_NEXT_IMAGE="ghcr.io/taller-sw-web/g6-productos-ofertas-backend/catalog-svc:${NEXT_SHA}"
readonly OLD_INVENTORY_IMAGE="ghcr.io/taller-sw-web/g6-productos-ofertas-backend/inventory-svc:1111111111111111111111111111111111111111"
readonly OLD_CATALOG_IMAGE="ghcr.io/taller-sw-web/g6-productos-ofertas-backend/catalog-svc:2222222222222222222222222222222222222222"
readonly SOURCE_ENGINE="${REPO_ROOT}/ops/oracle/deploy-g6-service.sh"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

source "${REPO_ROOT}/ops/oracle/service-registry.sh"
[[ "$(g6_enabled_services_json)" == '["inventory-svc"]' ]] || fail 'Inventario debe ser el único servicio habilitado'
[[ "$(awk -F'|' '$1 !~ /^#/ && NF { count++ } END { print count+0 }' "${REPO_ROOT}/ops/oracle/services.psv")" == 9 ]] ||
  fail 'el registro debe contener exactamente nueve servicios'

mkdir -p "$STAGED_OPS" "$MOCK_BIN" "$STATE_ROOT" \
  "${TEMP_ROOT}/opt/g6-productos-ofertas/inventory" \
  "${TEMP_ROOT}/opt/g6-productos-ofertas/shared" \
  "${TEMP_ROOT}/etc/g6-inventory" \
  "${TEMP_ROOT}/etc/g6-catalog-svc" \
  "${STATE_ROOT}/g6-inventory" \
  "${STATE_ROOT}/g6-productos-ofertas/catalog-svc"
cp "${REPO_ROOT}/ops/oracle/service-registry.sh" "$STAGED_OPS/service-registry.sh"
cp "${REPO_ROOT}/ops/oracle/services.psv" "$STAGED_OPS/services.psv"
cp "$SOURCE_ENGINE" "$STAGED_OPS/deploy-g6-service.sh"
cp "${REPO_ROOT}/ops/oracle/deploy-inventory-svc.sh" "$STAGED_OPS/deploy-inventory-svc.sh"
sed -i \
  -e "s|/opt/g6-productos-ofertas|${TEMP_ROOT}/opt/g6-productos-ofertas|g" \
  -e "s|/var/lib/g6-inventory|${STATE_ROOT}/g6-inventory|g" \
  -e "s|/var/lib/g6-productos-ofertas|${STATE_ROOT}/g6-productos-ofertas|g" \
  -e "s|/etc/g6-|${TEMP_ROOT}/etc/g6-|g" \
  "$STAGED_OPS/service-registry.sh"
sed -i \
  -e "s|/opt/g6-productos-ofertas|${TEMP_ROOT}/opt/g6-productos-ofertas|g" \
  -e "s|/var/lib/g6-inventory|${STATE_ROOT}/g6-inventory|g" \
  -e "s|/var/lib/g6-productos-ofertas|${STATE_ROOT}/g6-productos-ofertas|g" \
  -e "s|/etc/g6-|${TEMP_ROOT}/etc/g6-|g" \
  "$STAGED_OPS/services.psv"
# Solo en esta copia de pruebas se habilita catalog-svc para simular dos
# servicios registrados sin cambiar el estado de producción (que sigue cerrado).
sed -i 's/^catalog-svc|false|/catalog-svc|true|/' "$STAGED_OPS/services.psv"
# Elimina esperas únicamente en la copia aislada que usa esta simulación.
sed -i 's/sleep 2/: # espera omitida en simulación/g' "$STAGED_OPS/deploy-g6-service.sh"
sed -i "s|/etc/g6-inventory/runtime.env|${TEMP_ROOT}/etc/g6-inventory/runtime.env|g" "$STAGED_OPS/deploy-g6-service.sh"
sed -i "s|PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin|PATH=${MOCK_BIN}:/usr/bin:/bin|g" "$STAGED_OPS/deploy-g6-service.sh"
sed -i "s|/usr/local/lib/g6-productos-ofertas/deploy-g6-service|${STAGED_OPS}/deploy-g6-service.sh|g" "$STAGED_OPS/deploy-inventory-svc.sh"
chmod +x "$STAGED_OPS/deploy-g6-service.sh"
touch "${TEMP_ROOT}/opt/g6-productos-ofertas/inventory/docker-compose.inventory.yml"
touch "${TEMP_ROOT}/opt/g6-productos-ofertas/shared/docker-compose.service.yml"
printf '%s\n' 'DATABASE_URL=test-only' > "${TEMP_ROOT}/etc/g6-inventory/runtime.env"
: > "${TEMP_ROOT}/etc/g6-catalog-svc/runtime.env"

cat > "${MOCK_BIN}/docker" <<'MOCK_DOCKER'
#!/usr/bin/env bash
set -Eeuo pipefail
readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly ACTIVE_DIR="${ROOT}/var/lib/containers"
mkdir -p "$ACTIVE_DIR"

if [[ "${1:-}" == login ]]; then
  [[ "$(cat)" == 'simulation-only-token' ]] || exit 90
  [[ "$*" == *'--username simulation-only-user'* ]] || exit 91
  exit 0
fi

if [[ "${1:-}" == inspect ]]; then
  format="${3:-}"
  container="${4:-}"
  active_file="${ACTIVE_DIR}/${container}"
  [[ -f "$active_file" ]] || exit 1
  image="$(<"$active_file")"
  if [[ "$format" == '{{.Config.Image}}' ]]; then
    printf '%s\n' "$image"
    exit 0
  fi
  if [[ "$format" == '{{.State.Health.Status}}' ]]; then
    if [[ -f "${ROOT}/unhealthy-docker-image" && "$(<"${ROOT}/unhealthy-docker-image")" == "$image" ]]; then
      printf 'unhealthy\n'
    else
      printf 'healthy\n'
    fi
    exit 0
  fi
  exit 94
fi

[[ "${1:-}" == compose ]] || exit 92
project=''
for ((index = 1; index < $#; index++)); do
  if [[ "${!index}" == --project-name ]]; then
    next=$((index + 1))
    project="${!next}"
    break
  fi
done
case "$project" in
  g6-inventory) container=g6-inventory-svc ;;
  g6-catalog-svc) container=g6-catalog-svc ;;
  *) exit 93 ;;
esac
operation=''
for argument in "$@"; do
  case "$argument" in pull|up|rm) operation="$argument" ;; esac
done
if [[ "$container" == g6-inventory-svc ]]; then image="${INVENTORY_IMAGE:-}"; else image="${G6_SERVICE_IMAGE:-}"; fi
printf '%s %s %s\n' "$project" "$operation" "$image" >> "${ROOT}/docker.log"
printf '%s\n' "$container" > "${ROOT}/target-container"

case "$operation" in
  pull)
    if [[ -f "${ROOT}/fail-pull" && "$(<"${ROOT}/fail-pull")" == "$image" ]]; then exit 1; fi
    ;;
  up)
    if [[ -f "${ROOT}/fail-up" && "$(<"${ROOT}/fail-up")" == "$image" ]]; then exit 1; fi
    printf '%s\n' "$image" > "${ACTIVE_DIR}/${container}"
    ;;
  rm) rm -f "${ACTIVE_DIR}/${container}" ;;
  *) exit 95 ;;
esac
MOCK_DOCKER

cat > "${MOCK_BIN}/curl" <<'MOCK_CURL'
#!/usr/bin/env bash
set -Eeuo pipefail
readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
container="$(<"${ROOT}/target-container")"
active_file="${ROOT}/var/lib/containers/${container}"
[[ -f "$active_file" ]] || exit 7
image="$(<"$active_file")"
if [[ -f "${ROOT}/unhealthy-http-image" && "$(<"${ROOT}/unhealthy-http-image")" == "$image" ]]; then exit 8; fi
[[ "${1:-}" == --fail && "${2:-}" == --silent && "${3:-}" == "http://127.0.0.1:${MOCK_EXPECTED_PORT}/health" ]]
MOCK_CURL
cat > "${MOCK_BIN}/sleep" <<'MOCK_SLEEP'
#!/usr/bin/env bash
exit 0
MOCK_SLEEP
chmod +x "${MOCK_BIN}/docker" "${MOCK_BIN}/curl" "${MOCK_BIN}/sleep"

reset_simulation() {
  rm -rf "${TEMP_ROOT}/var/lib/containers"
  mkdir -p "${TEMP_ROOT}/var/lib/containers"
  rm -f "${TEMP_ROOT}/docker.log" "${TEMP_ROOT}/target-container" \
    "${TEMP_ROOT}/fail-pull" "${TEMP_ROOT}/fail-up" \
    "${TEMP_ROOT}/unhealthy-docker-image" "${TEMP_ROOT}/unhealthy-http-image"
}

run_deploy() {
  local command="$1" port="$2" expected_status="$3" executable="${4:-${STAGED_OPS}/deploy-g6-service.sh}" result
  if printf '%s\n%s\n' 'simulation-only-user' 'simulation-only-token' |
    env PATH="${MOCK_BIN}:${PATH}" SSH_ORIGINAL_COMMAND="$command" MOCK_EXPECTED_PORT="$port" \
      bash "$executable" > "${TEMP_ROOT}/result.log" 2>&1; then
    result=0
  else
    result=$?
  fi
  [[ "$result" == "$expected_status" ]] || fail "${command}: exit ${result}, esperado ${expected_status}: $(<"${TEMP_ROOT}/result.log")"
}

assert_value() {
  local path="$1" expected="$2"
  local actual=''
  [[ ! -f "$path" ]] || actual="$(<"$path")"
  [[ -f "$path" && "$actual" == "$expected" ]] || fail "valor inesperado en ${path}: '${actual}', esperado '${expected}'"
}

reset_simulation
printf '%s\n' "$OLD_INVENTORY_IMAGE" > "${TEMP_ROOT}/var/lib/containers/g6-inventory-svc"
printf '%s\n' "$OLD_CATALOG_IMAGE" > "${TEMP_ROOT}/var/lib/containers/g6-catalog-svc"
run_deploy "inventory-deploy ${IMAGE_SHA}" 3005 0 "${STAGED_OPS}/deploy-inventory-svc.sh"
assert_value "${STATE_ROOT}/g6-inventory/active-image" "$INVENTORY_IMAGE"
assert_value "${STATE_ROOT}/g6-inventory/previous-image" "$OLD_INVENTORY_IMAGE"
assert_value "${TEMP_ROOT}/var/lib/containers/g6-catalog-svc" "$OLD_CATALOG_IMAGE"
[[ "$(<"${TEMP_ROOT}/docker.log")" == $'g6-inventory pull ghcr.io/taller-sw-web/g6-productos-ofertas-backend/inventory-svc:0123456789012345678901234567890123456789\ng6-inventory up ghcr.io/taller-sw-web/g6-productos-ofertas-backend/inventory-svc:0123456789012345678901234567890123456789' ]] || fail 'Inventario no conservó su proyecto, puerto o flujo de operaciones'
printf 'PASS: comando SSH anterior y aislamiento de inventory-svc\n'

reset_simulation
printf '%s\n' "$OLD_INVENTORY_IMAGE" > "${TEMP_ROOT}/var/lib/containers/g6-inventory-svc"
printf '%s\n' "$OLD_CATALOG_IMAGE" > "${TEMP_ROOT}/var/lib/containers/g6-catalog-svc"
run_deploy "service-deploy catalog-svc ${IMAGE_SHA}" 3001 0
assert_value "${STATE_ROOT}/g6-productos-ofertas/catalog-svc/active-image" "$CATALOG_IMAGE"
assert_value "${STATE_ROOT}/g6-productos-ofertas/catalog-svc/previous-image" "$OLD_CATALOG_IMAGE"
assert_value "${TEMP_ROOT}/var/lib/containers/g6-inventory-svc" "$OLD_INVENTORY_IMAGE"
[[ "$(<"${TEMP_ROOT}/docker.log")" == $'g6-catalog-svc pull ghcr.io/taller-sw-web/g6-productos-ofertas-backend/catalog-svc:0123456789012345678901234567890123456789\ng6-catalog-svc up ghcr.io/taller-sw-web/g6-productos-ofertas-backend/catalog-svc:0123456789012345678901234567890123456789' ]] || fail 'catalog-svc alteró un proyecto o servicio no seleccionado'
printf 'PASS: ejecución genérica de catalog-svc aislada de Inventario\n'

reset_simulation
printf '%s\n' "$OLD_INVENTORY_IMAGE" > "${TEMP_ROOT}/var/lib/containers/g6-inventory-svc"
printf '%s\n' "$OLD_CATALOG_IMAGE" > "${TEMP_ROOT}/var/lib/containers/g6-catalog-svc"
printf '%s\n' "$CATALOG_NEXT_IMAGE" > "${TEMP_ROOT}/unhealthy-http-image"
run_deploy "service-deploy catalog-svc ${NEXT_SHA}" 3001 1
assert_value "${STATE_ROOT}/g6-productos-ofertas/catalog-svc/active-image" "$OLD_CATALOG_IMAGE"
assert_value "${STATE_ROOT}/g6-productos-ofertas/catalog-svc/previous-image" "$OLD_CATALOG_IMAGE"
assert_value "${TEMP_ROOT}/var/lib/containers/g6-inventory-svc" "$OLD_INVENTORY_IMAGE"
[[ "$(<"${TEMP_ROOT}/docker.log")" == $'g6-catalog-svc pull ghcr.io/taller-sw-web/g6-productos-ofertas-backend/catalog-svc:abcdefabcdefabcdefabcdefabcdefabcdefabcd\ng6-catalog-svc up ghcr.io/taller-sw-web/g6-productos-ofertas-backend/catalog-svc:abcdefabcdefabcdefabcdefabcdefabcdefabcd\ng6-catalog-svc up ghcr.io/taller-sw-web/g6-productos-ofertas-backend/catalog-svc:2222222222222222222222222222222222222222' ]] || fail 'rollback genérico no quedó confinado al servicio catalog-svc'
printf 'PASS: rollback catalog-svc sin modificar inventory-svc\n'

reset_simulation
printf '%s\n' "$OLD_INVENTORY_IMAGE" > "${TEMP_ROOT}/var/lib/containers/g6-inventory-svc"
printf '%s\n' "$INVENTORY_NEXT_IMAGE" > "${TEMP_ROOT}/unhealthy-http-image"
run_deploy "inventory-deploy ${NEXT_SHA}" 3005 1 "${STAGED_OPS}/deploy-inventory-svc.sh"
assert_value "${STATE_ROOT}/g6-inventory/active-image" "$OLD_INVENTORY_IMAGE"
assert_value "${STATE_ROOT}/g6-inventory/previous-image" "$OLD_INVENTORY_IMAGE"
printf 'PASS: rollback de Inventario mantiene imagen y estado previos\n'

for invalid_command in \
  'service-deploy unknown-svc 0123456789012345678901234567890123456789' \
  'service-deploy taxonomy-svc 0123456789012345678901234567890123456789' \
  'service-deploy catalog-svc ../../etc/passwd' \
  'service-deploy catalog-svc 0123456789012345678901234567890123456789;id' \
  'inventory-deploy 01234567890123456789012345678901234567890' \
  'service-deploy catalog-svc 0123456789012345678901234567890123456789 extra'; do
  reset_simulation
  run_deploy "$invalid_command" 3001 1
  [[ ! -s "${TEMP_ROOT}/docker.log" ]] || fail "entrada rechazada ejecutó operaciones Docker: ${invalid_command}"
done
printf 'PASS: nombres no registrados, servicios deshabilitados y entradas inválidas rechazadas\n'

printf 'Todas las simulaciones de despliegue genérico pasaron.\n'
