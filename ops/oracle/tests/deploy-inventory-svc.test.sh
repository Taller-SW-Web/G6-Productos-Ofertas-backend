#!/usr/bin/env bash
set -Eeuo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
readonly TEMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEMP_ROOT"' EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_file_value() {
  local path="$1"
  local expected="$2"
  [[ -f "$path" ]] || fail "falta archivo ${path}"
  [[ "$(<"$path")" == "$expected" ]] || fail "valor inesperado en ${path}"
}

readonly NEW_IMAGE="ghcr.io/taller-sw-web/g6-productos-ofertas-backend/inventory-svc:0123456789012345678901234567890123456789"
readonly OLD_IMAGE="ghcr.io/taller-sw-web/g6-productos-ofertas-backend/inventory-svc:previous"
readonly SOURCE_SCRIPT="${REPO_ROOT}/ops/oracle/deploy-inventory-svc.sh"

mkdir -p "${TEMP_ROOT}/bin"
sed \
  -e "s|/opt/g6-productos-ofertas/inventory|${TEMP_ROOT}/deploy|g" \
  -e "s|/etc/g6-inventory/runtime.env|${TEMP_ROOT}/runtime.env|g" \
  -e "s|/var/lib/g6-inventory|${TEMP_ROOT}/state|g" \
  "$SOURCE_SCRIPT" > "${TEMP_ROOT}/deploy-script.sh"
chmod +x "${TEMP_ROOT}/deploy-script.sh"

cat > "${TEMP_ROOT}/bin/docker" <<'MOCK_DOCKER'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "$1" == login ]]; then
  [[ "$(cat)" == 'simulation-only-token' ]] || exit 90
  [[ "$*" == *'--username simulation-only-user'* ]] || exit 91
  exit 0
fi
if [[ "$1" == inspect ]]; then
  format="${3:-}"
  if [[ "$format" == '{{.Config.Image}}' ]]; then
    if [[ ! -f "$MOCK_INSPECT_INITIAL_FILE" ]]; then
      : > "$MOCK_INSPECT_INITIAL_FILE"
      [[ -n "${MOCK_CURRENT_IMAGE:-}" ]] || exit 1
      printf '%s\n' "$MOCK_CURRENT_IMAGE"
    else
      [[ -f "$MOCK_ACTIVE_FILE" ]] || exit 1
      image="$(<"$MOCK_ACTIVE_FILE")"
      if [[ "$image" == "${MOCK_IMAGE_MISMATCH_FOR:-}" ]]; then image="mismatched-image"; fi
      printf '%s\n' "$image"
    fi
  elif [[ "$format" == '{{.State.Health.Status}}' ]]; then
    [[ -f "$MOCK_ACTIVE_FILE" ]] || exit 1
    image="$(<"$MOCK_ACTIVE_FILE")"
    if [[ "$image" == "${MOCK_UNHEALTHY_DOCKER_IMAGE:-}" ]]; then
      printf 'unhealthy\n'
    else
      printf 'healthy\n'
    fi
  else
    exit 94
  fi
  exit 0
fi
[[ "$1" == compose ]] || exit 92
operation=''
for argument in "$@"; do
  case "$argument" in
    pull|up|down) operation="$argument" ;;
  esac
done
case "$operation" in
  pull)
    printf 'pull %s\n' "$INVENTORY_IMAGE" >> "$MOCK_DOCKER_LOG"
    [[ "${MOCK_PULL_FAIL:-false}" != true ]]
    ;;
  up)
    printf 'up %s\n' "$INVENTORY_IMAGE" >> "$MOCK_DOCKER_LOG"
    if [[ "${MOCK_UP_FAIL_IMAGE:-}" == "$INVENTORY_IMAGE" ]]; then
      exit 1
    fi
    printf '%s\n' "$INVENTORY_IMAGE" > "$MOCK_ACTIVE_FILE"
    ;;
  down)
    printf 'down %s\n' "$INVENTORY_IMAGE" >> "$MOCK_DOCKER_LOG"
    rm -f "$MOCK_ACTIVE_FILE"
    ;;
  *) exit 93 ;;
esac
MOCK_DOCKER

cat > "${TEMP_ROOT}/bin/curl" <<'MOCK_CURL'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ -f "$MOCK_ACTIVE_FILE" ]] || exit 7
[[ "$(<"$MOCK_ACTIVE_FILE")" != "${MOCK_UNHEALTHY_IMAGE:-}" ]]
MOCK_CURL

cat > "${TEMP_ROOT}/bin/sleep" <<'MOCK_SLEEP'
#!/usr/bin/env bash
exit 0
MOCK_SLEEP

chmod +x "${TEMP_ROOT}/bin/docker" "${TEMP_ROOT}/bin/curl" "${TEMP_ROOT}/bin/sleep"
mkdir -p "${TEMP_ROOT}/deploy" "${TEMP_ROOT}/state"
touch "${TEMP_ROOT}/deploy/docker-compose.inventory.yml"
printf '%s\n' 'DATABASE_URL=test-only' > "${TEMP_ROOT}/runtime.env"

run_case() {
  local case_name="$1"
  local current_image="$2"
  local pull_fail="$3"
  local up_fail_image="$4"
  local unhealthy_image="$5"
  local expected_exit="$6"
  local expected_active="$7"
  local expected_previous="$8"
  local expected_log="$9"
  shift 9
  local image_mismatch_for="${1:-}"
  local unhealthy_docker_image="${2:-}"
  local expected_message="${3:-}"
  local result

  rm -rf "${TEMP_ROOT}/state"
  mkdir -p "${TEMP_ROOT}/state"
  : > "${TEMP_ROOT}/docker.log"
  rm -f "${TEMP_ROOT}/inspect-initial"
  if [[ -n "$current_image" ]]; then
    printf '%s\n' "$current_image" > "${TEMP_ROOT}/state/active-image"
  else
    rm -f "${TEMP_ROOT}/state/active-image"
  fi

  if printf '%s\n%s\n' 'simulation-only-user' 'simulation-only-token' |
    env PATH="${TEMP_ROOT}/bin:${PATH}" \
      SSH_ORIGINAL_COMMAND='inventory-deploy 0123456789012345678901234567890123456789' \
      MOCK_CURRENT_IMAGE="$current_image" \
      MOCK_PULL_FAIL="$pull_fail" \
      MOCK_UP_FAIL_IMAGE="$up_fail_image" \
      MOCK_UNHEALTHY_IMAGE="$unhealthy_image" \
      MOCK_ACTIVE_FILE="${TEMP_ROOT}/state/active-image" \
      MOCK_DOCKER_LOG="${TEMP_ROOT}/docker.log" \
      MOCK_INSPECT_INITIAL_FILE="${TEMP_ROOT}/inspect-initial" \
      MOCK_IMAGE_MISMATCH_FOR="$image_mismatch_for" \
      MOCK_UNHEALTHY_DOCKER_IMAGE="$unhealthy_docker_image" \
      bash "${TEMP_ROOT}/deploy-script.sh" > "${TEMP_ROOT}/${case_name}.log" 2>&1; then
    result=0
  else
    result=$?
  fi

  [[ "$result" == "$expected_exit" ]] || fail "${case_name}: exit ${result}, esperado ${expected_exit}"
  if [[ -n "$expected_active" ]]; then
    assert_file_value "${TEMP_ROOT}/state/active-image" "$expected_active"
  else
    [[ ! -f "${TEMP_ROOT}/state/active-image" ]] || fail "${case_name}: active-image debía faltar"
  fi
  if [[ -n "$expected_previous" ]]; then
    assert_file_value "${TEMP_ROOT}/state/previous-image" "$expected_previous"
  else
    [[ ! -f "${TEMP_ROOT}/state/previous-image" ]] || fail "${case_name}: previous-image debía faltar"
  fi
  [[ "$(<"${TEMP_ROOT}/docker.log")" == "$expected_log" ]] || fail "${case_name}: secuencia Docker inesperada"
  if [[ -n "$expected_message" ]]; then
    grep -q "$expected_message" "${TEMP_ROOT}/${case_name}.log" || fail "${case_name}: mensaje de error inesperado"
  fi
  printf 'PASS: %s\n' "$case_name"
}

run_case \
  'arranque exitoso' "$OLD_IMAGE" false '' '' 0 "$NEW_IMAGE" "$OLD_IMAGE" \
  "pull ${NEW_IMAGE}"$'\n'"up ${NEW_IMAGE}"

run_case \
  'fallo de descarga conserva versión activa' "$OLD_IMAGE" true '' '' 1 "$OLD_IMAGE" "$OLD_IMAGE" \
  "pull ${NEW_IMAGE}"

run_case \
  'fallo de arranque restaura versión anterior' "$OLD_IMAGE" false "$NEW_IMAGE" '' 1 "$OLD_IMAGE" "$OLD_IMAGE" \
  "pull ${NEW_IMAGE}"$'\n'"up ${NEW_IMAGE}"$'\n'"up ${OLD_IMAGE}"

run_case \
  'fallo de salud restaura versión anterior' "$OLD_IMAGE" false '' "$NEW_IMAGE" 1 "$OLD_IMAGE" "$OLD_IMAGE" \
  "pull ${NEW_IMAGE}"$'\n'"up ${NEW_IMAGE}"$'\n'"up ${OLD_IMAGE}"

run_case \
  'imagen desplegada distinta restaura versión anterior' "$OLD_IMAGE" false '' '' 1 "$OLD_IMAGE" "$OLD_IMAGE" \
  "pull ${NEW_IMAGE}"$'\n'"up ${NEW_IMAGE}"$'\n'"up ${OLD_IMAGE}" "$NEW_IMAGE" ''

run_case \
  'Docker no confirma salud y restaura versión anterior' "$OLD_IMAGE" false '' '' 1 "$OLD_IMAGE" "$OLD_IMAGE" \
  "pull ${NEW_IMAGE}"$'\n'"up ${NEW_IMAGE}"$'\n'"up ${OLD_IMAGE}" '' "$NEW_IMAGE"

run_case \
  'rollback con imagen incorrecta no se considera exitoso' "$OLD_IMAGE" false '' "$NEW_IMAGE" 1 "$OLD_IMAGE" "$OLD_IMAGE" \
  "pull ${NEW_IMAGE}"$'\n'"up ${NEW_IMAGE}"$'\n'"up ${OLD_IMAGE}" "$OLD_IMAGE" '' 'rollback.*no se pudo verificar'

run_case \
  'rollback sin estado saludable de Docker no se considera exitoso' "$OLD_IMAGE" false '' "$NEW_IMAGE" 1 "$OLD_IMAGE" "$OLD_IMAGE" \
  "pull ${NEW_IMAGE}"$'\n'"up ${NEW_IMAGE}"$'\n'"up ${OLD_IMAGE}" '' "$OLD_IMAGE" 'rollback.*no se pudo verificar'

run_case \
  'primer despliegue no saludable sin versión anterior' '' false '' "$NEW_IMAGE" 1 '' '' \
  "pull ${NEW_IMAGE}"$'\n'"up ${NEW_IMAGE}"$'\n'"down ${NEW_IMAGE}"

printf '%s\n' "DATABASE_URL=''" > "${TEMP_ROOT}/runtime.env"
: > "${TEMP_ROOT}/docker.log"
if printf '%s\n%s\n' 'simulation-only-user' 'simulation-only-token' |
  env PATH="${TEMP_ROOT}/bin:${PATH}" \
    SSH_ORIGINAL_COMMAND='inventory-deploy 0123456789012345678901234567890123456789' \
    MOCK_CURRENT_IMAGE="$OLD_IMAGE" \
    MOCK_PULL_FAIL=false \
    MOCK_UP_FAIL_IMAGE='' \
    MOCK_UNHEALTHY_IMAGE='' \
    MOCK_ACTIVE_FILE="${TEMP_ROOT}/state/active-image" \
    MOCK_DOCKER_LOG="${TEMP_ROOT}/docker.log" \
    bash "${TEMP_ROOT}/deploy-script.sh" > "${TEMP_ROOT}/empty-database-url.log" 2>&1; then
  fail 'DATABASE_URL vacío debía detener el despliegue'
fi
[[ ! -s "${TEMP_ROOT}/docker.log" ]] || fail 'DATABASE_URL vacío no debía iniciar operaciones Docker'
grep -q 'DATABASE_URL no está definido' "${TEMP_ROOT}/empty-database-url.log" ||
  fail 'DATABASE_URL vacío no produjo el error de prevalidación esperado'
printf 'PASS: DATABASE_URL vacío detiene el despliegue antes de Docker\n'

printf 'Todas las simulaciones de despliegue pasaron.\n'
