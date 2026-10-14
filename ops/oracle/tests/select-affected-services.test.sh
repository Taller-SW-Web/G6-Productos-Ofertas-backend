#!/usr/bin/env bash
set -Eeuo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
readonly TEMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEMP_ROOT"' EXIT
mkdir -p "$TEMP_ROOT/ops/oracle"
cp "$ROOT/ops/oracle/service-registry.sh" "$ROOT/ops/oracle/services.psv" \
  "$ROOT/ops/oracle/select-affected-services.sh" "$TEMP_ROOT/ops/oracle/"
sed -i 's/^catalog-svc|false|/catalog-svc|true|/' "$TEMP_ROOT/ops/oracle/services.psv"

run_selection() {
  local expected="$1"
  shift
  local actual
  actual="$(printf '%s\0' "$@" | bash "$TEMP_ROOT/ops/oracle/select-affected-services.sh")"
  [[ "$actual" == "$expected" ]] || {
    printf 'FAIL: selección para [%s], actual %s, esperado %s\n' "$*" "$actual" "$expected" >&2
    exit 1
  }
}

run_selection '["inventory-svc"]' apps/inventory-svc/src/main.ts
run_selection '["catalog-svc"]' apps/catalog-svc/src/main.ts
run_selection '["catalog-svc","inventory-svc"]' apps/inventory-svc/src/main.ts apps/catalog-svc/src/main.ts
run_selection '["catalog-svc","inventory-svc"]' package-lock.json
run_selection '["catalog-svc","inventory-svc"]' apps/shared/health.ts
run_selection '["catalog-svc","inventory-svc"]'

source "$ROOT/ops/oracle/service-registry.sh"
[[ "$(g6_enabled_services_json)" == '["inventory-svc"]' ]] || {
  echo 'FAIL: la simulación alteró el registro de producción.' >&2
  exit 1
}
printf 'PASS: selección específica, compartida y fallback conservador sin habilitar servicios en producción\n'
