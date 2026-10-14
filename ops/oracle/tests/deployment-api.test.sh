#!/usr/bin/env bash
set -Eeuo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
readonly TEMP_ROOT="$(mktemp -d)"
readonly MOCK_STATE="$TEMP_ROOT/api-state"
readonly MOCK_BIN="$TEMP_ROOT/bin"
readonly REPO="$TEMP_ROOT/repo"
trap 'rm -rf "$TEMP_ROOT"' EXIT
mkdir -p "$MOCK_STATE" "$MOCK_BIN" "$REPO" "$TEMP_ROOT/ops/oracle"
cp "$ROOT/ops/oracle/service-registry.sh" "$ROOT/ops/oracle/services.psv" \
  "$ROOT/ops/oracle/select-cd-services.sh" "$ROOT/ops/oracle/github-deployment-api.sh" \
  "$TEMP_ROOT/ops/oracle/"
readonly ORACLE_DIR="$TEMP_ROOT/ops/oracle"

# Sustituye GitHub API y jq por dobles deterministas; valida argumentos,
# parámetros de consulta y payloads, y persiste lo escrito para que el selector
# ejecute la lectura sobre la misma API simulada.
cat > "$MOCK_BIN/gh" <<'MOCK_GH'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${1:-}" == api ]] || exit 2
shift
method=GET input= endpoint= state= description= jq=
while (($#)); do
  case "$1" in
    --paginate) shift ;;
    --method) method="$2"; shift 2 ;;
    --input) input="$2"; shift 2 ;;
    --jq) jq="$2"; shift 2 ;;
    -f) key="${2%%=*}"; value="${2#*=}"; [[ "$key" == state ]] && state="$value" || description="$value"; shift 2 ;;
    -*) echo "opción inesperada: $1" >&2; exit 2 ;;
    *) endpoint="$1"; shift ;;
  esac
done
deployments="$MOCK_STATE/deployments.tsv"
if [[ "$method" == POST && "$endpoint" == repos/example/backend/deployments ]]; then
  expected="{\"ref\":\"$EXPECT_SHA\",\"task\":\"deploy\",\"environment\":\"g6-oracle-inventory-svc\",\"auto_merge\":false,\"required_contexts\":[],\"production_environment\":true}"
  [[ -n "$input" && "$jq" == .id && "$(cat "$input")" == "$expected" ]] || { echo 'payload de creación inválido' >&2; exit 2; }
  id=100
  printf '%s\t%s\t%s\t%s\t%s\n' "$id" "$EXPECT_SHA" '2026-03-01T00:00:00Z' g6-oracle-inventory-svc deploy >> "$deployments"
  : > "$MOCK_STATE/$id.statuses.tsv"
  printf '%s\n' "$id"
elif [[ "$method" == POST && "$endpoint" =~ ^repos/example/backend/deployments/([0-9]+)/statuses$ ]]; then
  id="${BASH_REMATCH[1]}"
  case "$state" in
    in_progress) expected='Despliegue Oracle en curso; aún no es una versión exitosa.' ;;
    success) expected='SSH completó el despliegue y sus verificaciones de salud.' ;;
    failure) expected='El despliegue remoto no terminó correctamente; no se avanza el SHA exitoso.' ;;
    *) exit 2 ;;
  esac
  [[ "$description" == "$expected" && -f "$MOCK_STATE/$id.statuses.tsv" ]] || { echo 'payload de estado inválido' >&2; exit 2; }
  status_id="$(($(wc -l < "$MOCK_STATE/$id.statuses.tsv") + 1000))"
  printf '%s\t%s\t%s\n' "$status_id" "$state" '2026-03-01T00:00:00Z' >> "$MOCK_STATE/$id.statuses.tsv"
elif [[ "$method" == GET && "$endpoint" == repos/example/backend/deployments\?* ]]; then
  [[ "$endpoint" == *'environment=g6-oracle-inventory-svc'*'task=deploy'*'per_page=100'* ]] || { echo 'query de Deployments inválida' >&2; exit 2; }
  awk -F '\t' '$4 == "g6-oracle-inventory-svc" && $5 == "deploy" { print $1 "\t" $2 "\t" $3 }' "$deployments"
elif [[ "$method" == GET && "$endpoint" =~ ^repos/example/backend/deployments/([0-9]+)/statuses\?per_page=100$ ]]; then
  id="${BASH_REMATCH[1]}"
  [[ -f "$MOCK_STATE/$id.statuses.tsv" ]] && cat "$MOCK_STATE/$id.statuses.tsv"
else
  echo "solicitud API inesperada: $method $endpoint" >&2
  exit 2
fi
MOCK_GH
chmod +x "$MOCK_BIN/gh"

cat > "$MOCK_BIN/jq" <<'MOCK_JQ'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$1" == -cn && "$2" == --arg && "$3" == ref && "$5" == --arg && "$6" == environment && "$8" == '{ref:$ref, task:"deploy", environment:$environment, auto_merge:false, required_contexts:[], production_environment:true}' ]] || exit 2
printf '{"ref":"%s","task":"deploy","environment":"%s","auto_merge":false,"required_contexts":[],"production_environment":true}\n' "$4" "$7"
MOCK_JQ
chmod +x "$MOCK_BIN/jq"

git init --quiet --initial-branch=master "$REPO"
git -C "$REPO" config user.name 'Pruebas INFRA-002'
git -C "$REPO" config user.email 'infra-002@example.invalid'
mkdir -p "$REPO/apps/inventory-svc/src"
printf 'base\n' > "$REPO/apps/inventory-svc/src/main.ts"
git -C "$REPO" add .
git -C "$REPO" commit --quiet -m 'base'
readonly SHA="$(git -C "$REPO" rev-parse HEAD)"

run_api() { env PATH="$MOCK_BIN:$PATH" MOCK_STATE="$MOCK_STATE" EXPECT_SHA="$SHA" bash "$ORACLE_DIR/github-deployment-api.sh" "$@"; }
run_selector() { (cd "$REPO" && env PATH="$MOCK_BIN:$PATH" MOCK_STATE="$MOCK_STATE" bash "$ORACLE_DIR/select-cd-services.sh" automatic example/backend "$SHA"); }

deployment_id="$(run_api create example/backend inventory-svc "$SHA")"
[[ "$deployment_id" == 100 ]]
[[ "$(run_selector)" == '["inventory-svc"]' ]]
run_api status example/backend "$deployment_id" success
[[ "$(run_selector)" == '[]' ]]
printf 'PASS: mock API validó parámetros, creación, estados y lectura del baseline exitoso.\n'

if run_api create example/backend taxonomy-svc "$SHA" >/dev/null 2>&1; then
  echo 'FAIL: se permitió crear un Deployment para servicio deshabilitado.' >&2
  exit 1
fi
if run_api status example/backend '100/../../x' success >/dev/null 2>&1; then
  echo 'FAIL: se aceptó un ID externo que podría alterar el endpoint.' >&2
  exit 1
fi
printf 'PASS: se rechazaron servicio deshabilitado e ID manipulado.\n'
