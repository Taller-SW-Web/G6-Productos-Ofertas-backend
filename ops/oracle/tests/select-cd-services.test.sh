#!/usr/bin/env bash
set -Eeuo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
readonly TEMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEMP_ROOT"' EXIT
mkdir -p "$TEMP_ROOT/ops/oracle"
cp "$ROOT/ops/oracle/service-registry.sh" "$ROOT/ops/oracle/services.psv" \
  "$ROOT/ops/oracle/select-cd-services.sh" "$TEMP_ROOT/ops/oracle/"
sed -i 's/^catalog-svc|false|/catalog-svc|true|/' "$TEMP_ROOT/ops/oracle/services.psv"

readonly SELECTOR="$TEMP_ROOT/ops/oracle/select-cd-services.sh"
readonly ALL_ENABLED='["catalog-svc","inventory-svc"]'
readonly WORKFLOW="$ROOT/.github/workflows/cd-services-oracle.yml"

expect_selection() {
  local expected="$1"
  shift
  local actual
  actual="$(bash "$SELECTOR" "$@")"
  [[ "$actual" == "$expected" ]] || {
    printf 'FAIL: selección %s dio %s, esperado %s\n' "$*" "$actual" "$expected" >&2
    exit 1
  }
}

# Casos de recuperación: cada evento de CI exitoso vuelve a seleccionar todo,
# aunque el CD previo fallara/cancelara o hubiera CI fallido/cancelado intermedio.
for scenario in \
  'CI verde después de CD fallido' \
  'CI verde después de CI fallido intermedio' \
  'CI verde después de CI cancelado' \
  'commits consecutivos de inventario y catálogo'; do
  expect_selection "$ALL_ENABLED" automatic
  printf 'PASS: recuperación conservadora (%s)\n' "$scenario"
done
grep -Fq 'github.event.workflow_run.conclusion == '\''success'\''' "$WORKFLOW" || {
  echo 'FAIL: el workflow no conserva el requisito de CI exitoso.' >&2
  exit 1
}
grep -Fq 'github.event.workflow_run.head_branch == '\''master'\''' "$WORKFLOW" || {
  echo 'FAIL: el workflow no restringe CI automático a master.' >&2
  exit 1
}
grep -Fq 'select-cd-services.sh automatic' "$WORKFLOW" || {
  echo 'FAIL: el workflow no usa el selector conservador probado.' >&2
  exit 1
}

# La selección manual sigue siendo exacta y cerrada.
expect_selection '["inventory-svc"]' manual inventory-svc
if bash "$SELECTOR" manual taxonomy-svc >/dev/null 2>&1; then
  echo 'FAIL: se aceptó dispatch manual de un servicio deshabilitado.' >&2
  exit 1
fi
if bash "$SELECTOR" manual unknown-svc >/dev/null 2>&1; then
  echo 'FAIL: se aceptó dispatch manual fuera del registro.' >&2
  exit 1
fi
source "$ROOT/ops/oracle/service-registry.sh"
[[ "$(g6_enabled_services_json)" == '["inventory-svc"]' ]] || {
  echo 'FAIL: la simulación alteró el registro de producción.' >&2
  exit 1
}
printf 'PASS: dispatch manual por servicio y registro de producción intacto\n'
