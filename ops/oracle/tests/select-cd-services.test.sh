#!/usr/bin/env bash
set -Eeuo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
readonly TEMP_ROOT="$(mktemp -d)"
readonly GIT_ROOT="$TEMP_ROOT/repo"
readonly MOCK_BIN="$TEMP_ROOT/bin"
readonly MOCK_STATE="$TEMP_ROOT/github-deployments"
trap 'rm -rf "$TEMP_ROOT"' EXIT
mkdir -p "$TEMP_ROOT/ops/oracle" "$MOCK_BIN" "$MOCK_STATE"
cp "$ROOT/ops/oracle/service-registry.sh" "$ROOT/ops/oracle/services.psv" \
  "$ROOT/ops/oracle/select-cd-services.sh" "$TEMP_ROOT/ops/oracle/"
sed -i 's/^catalog-svc|false|/catalog-svc|true|/' "$TEMP_ROOT/ops/oracle/services.psv"
readonly SELECTOR="$TEMP_ROOT/ops/oracle/select-cd-services.sh"

git init --quiet --initial-branch=master "$GIT_ROOT"
git -C "$GIT_ROOT" config user.name 'Pruebas INFRA-002'
git -C "$GIT_ROOT" config user.email 'infra-002@example.invalid'
mkdir -p "$GIT_ROOT/apps/inventory-svc/src" "$GIT_ROOT/apps/catalog-svc/src" "$GIT_ROOT/docs"
printf 'inventory base\n' > "$GIT_ROOT/apps/inventory-svc/src/main.ts"
printf 'catalog base\n' > "$GIT_ROOT/apps/catalog-svc/src/main.ts"
printf '{}\n' > "$GIT_ROOT/package.json"
printf 'FROM node:24\n' > "$GIT_ROOT/Dockerfile.service"
printf 'docs\n' > "$GIT_ROOT/docs/README.md"
git -C "$GIT_ROOT" add .
git -C "$GIT_ROOT" commit --quiet -m 'base'
BASE_SHA="$(git -C "$GIT_ROOT" rev-parse HEAD)"

cat > "$MOCK_BIN/gh" <<'MOCK_GH'
#!/usr/bin/env bash
set -Eeuo pipefail
endpoint="${!#}"
if [[ "$endpoint" == *'/actions/workflows/ci.yml/runs?'* ]]; then
  [[ ! -f "${MOCK_STATE}/ci.api-error" ]] || exit 1
  [[ -f "${MOCK_STATE}/ci-push-runs.tsv" ]] || exit 0
  cat "${MOCK_STATE}/ci-push-runs.tsv"
elif [[ "$endpoint" == *'/deployments/'*'/statuses?'* ]]; then
  remainder="${endpoint#*/deployments/}"
  deployment_id="${remainder%%/*}"
  [[ -f "${MOCK_STATE}/${deployment_id}.statuses.tsv" ]] || exit 0
  cat "${MOCK_STATE}/${deployment_id}.statuses.tsv"
elif [[ "$endpoint" == *'/deployments?environment='* ]]; then
  service="${endpoint#*environment=g6-oracle-}"
  service="${service%%&*}"
  [[ ! -f "${MOCK_STATE}/${service}.api-error" ]] || exit 1
  [[ -f "${MOCK_STATE}/${service}.deployments.tsv" ]] || exit 0
  cat "${MOCK_STATE}/${service}.deployments.tsv"
else
  echo "unexpected gh api endpoint: $endpoint" >&2
  exit 2
fi
MOCK_GH
chmod +x "$MOCK_BIN/gh"

record_deployment() {
  local service="$1" id="$2" sha="$3" state="$4" created="$5"
  printf '%s\t%s\t%s\n' "$id" "$sha" "$created" >> "$MOCK_STATE/${service}.deployments.tsv"
  record_status "$id" "$state" "$created"
}

record_status() {
  local id="$1" state="$2" created="$3" status_id
  status_id="$(($(cat "$MOCK_STATE/next-status-id" 2>/dev/null || printf '999') + 1))"
  printf '%s\n' "$status_id" > "$MOCK_STATE/next-status-id"
  printf '%s\t%s\t%s\n' "$status_id" "$state" "$created" >> "$MOCK_STATE/${id}.statuses.tsv"
}

record_ci_push_success() {
  local run_number="$1" sha="$2"
  printf '%s\t%s\n' "$run_number" "$sha" >> "$MOCK_STATE/ci-push-runs.tsv"
}

select_auto() {
  (cd "$GIT_ROOT" && env PATH="$MOCK_BIN:$PATH" MOCK_STATE="$MOCK_STATE" \
    bash "$SELECTOR" automatic example/backend "$(git rev-parse HEAD)")
}

expect_selection() {
  local expected="$1" actual
  actual="$(select_auto)"
  [[ "$actual" == "$expected" ]] || {
    printf 'FAIL: selección actual %s, esperado %s\n' "$actual" "$expected" >&2
    exit 1
  }
  printf 'PASS: selección conservadora %s\n' "$expected"
}

# Un cambio de control aislado desde un baseline CI exitoso no dispara el
# fallback de Inventory sin deployment history.
record_ci_push_success 1 "$BASE_SHA"
mkdir -p "$GIT_ROOT/ops/oracle"
printf 'executor control\n' > "$GIT_ROOT/ops/oracle/deploy-g6-service.sh"
git -C "$GIT_ROOT" add .
git -C "$GIT_ROOT" commit --quiet -m 'infraestructura oracle control'
INFRA_SHA="$(git -C "$GIT_ROOT" rev-parse HEAD)"
record_ci_push_success 2 "$INFRA_SHA"
expect_selection '[]'
touch "$MOCK_STATE/ci.api-error"
expect_selection '["catalog-svc","inventory-svc"]'
rm -f "$MOCK_STATE/ci.api-error"

# Reproduce un solo push con commits de aplicación/build seguidos por un último
# commit que solo modifica control. El diff contra el padre inmediato no ve los
# cambios previos; el rango desde el último CI exitoso sí debe seleccionarlos.
printf 'inventory cambio agrupado\n' >> "$GIT_ROOT/apps/inventory-svc/src/main.ts"
git -C "$GIT_ROOT" add .
git -C "$GIT_ROOT" commit --quiet -m 'inventario antes de control'
printf 'build input\n' > "$GIT_ROOT/ops/oracle/build-service.sh"
git -C "$GIT_ROOT" add .
git -C "$GIT_ROOT" commit --quiet -m 'cambio de input de build'
printf 'documentación de control\n' >> "$GIT_ROOT/ops/oracle/deploy-g6-service.sh"
git -C "$GIT_ROOT" add .
git -C "$GIT_ROOT" commit --quiet -m 'control al final del push'
MULTI_PUSH_SHA="$(git -C "$GIT_ROOT" rev-parse HEAD)"
record_ci_push_success 3 "$MULTI_PUSH_SHA"
expect_selection '["catalog-svc","inventory-svc"]'

# Un merge commit con padres múltiples se compara contra el último CI exitoso
# de master, no únicamente contra el primer padre inmediato.
git -C "$GIT_ROOT" checkout --quiet -b infra-merge-side "$MULTI_PUSH_SHA"
printf 'merge infra\n' > "$GIT_ROOT/ops/oracle/README.md"
git -C "$GIT_ROOT" add .
git -C "$GIT_ROOT" commit --quiet -m 'infra merge side'
git -C "$GIT_ROOT" checkout --quiet master
git -C "$GIT_ROOT" merge --quiet --no-ff infra-merge-side -m 'merge infra control'
MERGE_SHA="$(git -C "$GIT_ROOT" rev-parse HEAD)"
record_ci_push_success 4 "$MERGE_SHA"
expect_selection '[]'

BASE_SHA="$(git -C "$GIT_ROOT" rev-parse HEAD)"
record_deployment inventory-svc 1 "$BASE_SHA" success '2026-01-01T00:00:00Z'
record_deployment catalog-svc 11 "$BASE_SHA" success '2026-01-01T00:00:00Z'

# Un cambio exclusivo selecciona solo su aplicación cuando la última versión
# satisfactoria de cada servicio está disponible en GitHub Deployments.
printf 'inventory cambio 1\n' >> "$GIT_ROOT/apps/inventory-svc/src/main.ts"
git -C "$GIT_ROOT" add .
git -C "$GIT_ROOT" commit --quiet -m 'inventario 1'
INVENTORY_SHA="$(git -C "$GIT_ROOT" rev-parse HEAD)"
expect_selection '["inventory-svc"]'

record_deployment inventory-svc 2 "$INVENTORY_SHA" success '2026-01-02T00:00:00Z'
printf 'catalog cambio 1\n' >> "$GIT_ROOT/apps/catalog-svc/src/main.ts"
git -C "$GIT_ROOT" add .
git -C "$GIT_ROOT" commit --quiet -m 'catalogo 1'
CATALOG_SHA="$(git -C "$GIT_ROOT" rev-parse HEAD)"
expect_selection '["catalog-svc"]'

# Dependencias, Dockerfiles y configuración fuera de apps/<servicio> se tratan
# como compartidos y seleccionan todos los habilitados.
record_deployment catalog-svc 12 "$CATALOG_SHA" success '2026-01-03T00:00:00Z'
printf '{"shared":true}\n' > "$GIT_ROOT/package.json"
printf 'FROM node:24-alpine\n' > "$GIT_ROOT/Dockerfile.service"
git -C "$GIT_ROOT" add .
git -C "$GIT_ROOT" commit --quiet -m 'dependencias compartidas'
SHARED_SHA="$(git -C "$GIT_ROOT" rev-parse HEAD)"
expect_selection '["catalog-svc","inventory-svc"]'
record_deployment inventory-svc 8 "$SHARED_SHA" success '2026-01-03T01:00:00Z'
record_deployment catalog-svc 15 "$SHARED_SHA" success '2026-01-03T01:00:00Z'

# Un intento fallido no avanza el baseline; los cambios posteriores siguen
# seleccionando el servicio pendiente.
printf 'inventory cambio 2\n' >> "$GIT_ROOT/apps/inventory-svc/src/main.ts"
git -C "$GIT_ROOT" add .
git -C "$GIT_ROOT" commit --quiet -m 'inventario 2'
INVENTORY_PENDING_SHA="$(git -C "$GIT_ROOT" rev-parse HEAD)"
expect_selection '["inventory-svc"]' # CI fail/cancel creates no success record; prior SHA stays the baseline.
record_deployment inventory-svc 3 "$INVENTORY_PENDING_SHA" failure '2026-01-04T00:00:00Z'
record_deployment catalog-svc 13 "$SHARED_SHA" success '2026-01-04T00:00:00Z'
record_deployment inventory-svc 9 "$SHARED_SHA" success '2026-01-03T01:00:00Z'
expect_selection '["inventory-svc"]'

# Un intento cancelado que quedó in_progress no se toma como éxito verificable.
record_deployment inventory-svc 4 "$INVENTORY_PENDING_SHA" in_progress '2026-01-05T00:00:00Z'
expect_selection '["inventory-svc"]'

# Un estado sin historial de status completo tampoco se acepta como éxito.
printf '%s\t%s\t%s\n' 16 "$INVENTORY_PENDING_SHA" '2026-01-05T12:00:00Z' >> "$MOCK_STATE/inventory-svc.deployments.tsv"
expect_selection '["inventory-svc"]'

# Ausencia de historial y error de consulta incluyen el servicio afectado aunque
# el diff entre SHA no muestre cambios locales para ese servicio.
rm -f "$MOCK_STATE/catalog-svc.deployments.tsv"
record_deployment inventory-svc 5 "$INVENTORY_PENDING_SHA" success '2026-01-06T00:00:00Z'
expect_selection '["catalog-svc"]'
touch "$MOCK_STATE/catalog-svc.api-error"
expect_selection '["catalog-svc"]'
rm -f "$MOCK_STATE/catalog-svc.api-error"

# Los docs excluidos no reconstruyen imágenes; el alta temporal de un servicio
# habilitado sin ningún deployment registrado lo selecciona por seguridad.
printf 'documentación\n' > "$GIT_ROOT/docs/README.md"
git -C "$GIT_ROOT" add .
git -C "$GIT_ROOT" commit --quiet -m 'documentacion'
record_deployment catalog-svc 14 "$(git -C "$GIT_ROOT" rev-parse HEAD)" success '2026-01-07T00:00:00Z'
record_deployment inventory-svc 6 "$(git -C "$GIT_ROOT" rev-parse HEAD)" success '2026-01-07T00:00:00Z'
expect_selection '[]'
sed -i 's/^combos-svc|false|/combos-svc|true|/' "$TEMP_ROOT/ops/oracle/services.psv"
expect_selection '["combos-svc"]'

# Dispatch sigue siendo individual y cerrado; el registro versionado original
# nunca habilita servicios adicionales.
manual="$(bash "$SELECTOR" manual inventory-svc)"
[[ "$manual" == '["inventory-svc"]' ]]
if bash "$SELECTOR" manual taxonomy-svc >/dev/null 2>&1; then
  echo 'FAIL: se aceptó dispatch manual de un servicio deshabilitado.' >&2
  exit 1
fi
source "$ROOT/ops/oracle/service-registry.sh"
[[ "$(g6_enabled_services_json)" == '["inventory-svc"]' ]]

readonly WORKFLOW="$ROOT/.github/workflows/cd-services-oracle.yml"
grep -Fq 'github.event.workflow_run.conclusion == '\''success'\''' "$WORKFLOW"
grep -Fq 'github.event.workflow_run.head_branch == '\''master'\''' "$WORKFLOW"
grep -Fq 'deployments: read' "$WORKFLOW"
grep -Fq 'deployments: write' "$WORKFLOW"
grep -Fq 'github-deployment-api.sh create' "$WORKFLOW"
grep -Fq 'github-deployment-api.sh status "$GITHUB_REPOSITORY" "$DEPLOYMENT_ID" success' "$WORKFLOW"
grep -Fq 'github-deployment-api.sh status "$GITHUB_REPOSITORY" "$DEPLOYMENT_ID" failure' "$WORKFLOW"
deploy_line="$(grep -n 'name: Deploy image, check health and roll back on failure' "$WORKFLOW" | cut -d: -f1)"
success_line="$(grep -n 'name: Record successful deployment after remote health checks' "$WORKFLOW" | cut -d: -f1)"
((success_line > deploy_line)) || { echo 'FAIL: se registraría éxito antes de terminar el despliegue remoto.' >&2; exit 1; }
printf 'PASS: Deployments solo registra éxito tras SSH y mantiene permisos separados\n'

# Desempates reproducibles con IDs numéricos de longitudes diferentes y API
# deliberadamente desordenada.
reset_inventory_history() {
  rm -f "$MOCK_STATE/inventory-svc.deployments.tsv" "$MOCK_STATE/99.statuses.tsv" "$MOCK_STATE/100.statuses.tsv"
}
sed -i 's/^combos-svc|true|/combos-svc|false|/' "$TEMP_ROOT/ops/oracle/services.psv"
record_deployment catalog-svc 88 "$(git -C "$GIT_ROOT" rev-parse HEAD)" success '2026-02-01T00:00:00Z'
CURRENT_SHA="$(git -C "$GIT_ROOT" rev-parse HEAD)"
reset_inventory_history
record_deployment inventory-svc 99 "$BASE_SHA" success '2026-02-01T00:00:00Z'
record_deployment inventory-svc 100 "$CURRENT_SHA" failure '2026-02-01T00:00:00Z'
{ tail -n 1 "$MOCK_STATE/inventory-svc.deployments.tsv"; head -n 1 "$MOCK_STATE/inventory-svc.deployments.tsv"; } > "$MOCK_STATE/shuffled.tsv"
mv "$MOCK_STATE/shuffled.tsv" "$MOCK_STATE/inventory-svc.deployments.tsv"
expect_selection '["inventory-svc"]'

reset_inventory_history
record_deployment inventory-svc 99 "$BASE_SHA" success '2026-02-01T00:00:00Z'
record_deployment inventory-svc 100 "$CURRENT_SHA" in_progress '2026-02-01T00:00:00Z'
expect_selection '["inventory-svc"]'

reset_inventory_history
record_deployment inventory-svc 100 "$CURRENT_SHA" success '2026-02-02T00:00:00Z'
printf '%s\t%s\t%s\n%s\t%s\t%s\n' 999 success '2026-02-02T00:00:01Z' \
  1000 failure '2026-02-02T00:00:01Z' > "$MOCK_STATE/100.statuses.tsv"
expect_selection '["inventory-svc"]'
printf '%s\t%s\t%s\n%s\t%s\t%s\n' 999 failure '2026-02-02T00:00:01Z' \
  1000 success '2026-02-02T00:00:01Z' > "$MOCK_STATE/100.statuses.tsv"
expect_selection '[]'

# IDs repetidos impiden establecer un orden confiable y fuerzan selección segura.
reset_inventory_history
record_deployment inventory-svc 99 "$CURRENT_SHA" success '2026-02-02T00:00:00Z'
printf '%s\t%s\t%s\n' 99 "$BASE_SHA" '2026-02-02T00:00:00Z' >> "$MOCK_STATE/inventory-svc.deployments.tsv"
expect_selection '["inventory-svc"]'

reset_inventory_history
record_deployment inventory-svc 100 "$CURRENT_SHA" success '2026-02-03T00:00:00Z'
record_deployment inventory-svc 99 "$BASE_SHA" success '2026-02-02T00:00:00Z'
expect_selection '[]'
