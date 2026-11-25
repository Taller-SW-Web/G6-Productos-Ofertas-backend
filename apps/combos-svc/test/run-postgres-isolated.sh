#!/usr/bin/env bash
set -Eeuo pipefail

mode='legacy'
test_file=''
test_name_pattern=''
while (($#)); do
  case "$1" in
    --mode)
      mode="${2:?--mode requiere un valor (legacy o postgres-only)}"
      shift 2
      ;;
    --postgres-only)
      mode='postgres-only'
      shift
      ;;
    --test-file)
      test_file="${2:?--test-file requiere un nombre}"
      shift 2
      ;;
    --test-name-pattern)
      test_name_pattern="${2:?--test-name-pattern requiere un patrón}"
      shift 2
      ;;
    *)
      printf 'Argumento no reconocido: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

case "$mode" in
  legacy|postgres-only) ;;
  *)
    printf 'Modo no reconocido: %s (use legacy o postgres-only)\n' "$mode" >&2
    exit 2
    ;;
esac

if [[ "$mode" == 'postgres-only' ]]; then
  case "$test_file" in
    ''|combos-postgres.e2e-spec.ts|combos-h5-performance.e2e-spec.ts) ;;
    *)
      printf 'Suite focalizada no permitida en modo postgres-only: %s\n' "$test_file" >&2
      exit 2
      ;;
  esac
  if [[ -z "$test_file" ]]; then
    test_file='combos-postgres.e2e-spec.ts'
  fi
  if [[ "$test_file" == 'combos-h5-performance.e2e-spec.ts' && "${G6_PERFORMANCE_HTTP:-}" != 1 ]]; then
    printf 'combos-h5-performance.e2e-spec.ts requiere G6_PERFORMANCE_HTTP=1.\n' >&2
    exit 2
  fi
  expected_suites="$test_file"
else
  case "$test_file" in
    ''|app.e2e-spec.ts|combos-postgres.e2e-spec.ts|combos-rabbitmq.e2e-spec.ts|combos-catalog-rabbitmq.e2e-spec.ts) ;;
    *) printf 'Suite focalizada no permitida: %s\n' "$test_file" >&2; exit 2 ;;
  esac
  if [[ -n "$test_file" ]]; then
    expected_suites="$test_file"
  else
    expected_suites='app.e2e-spec.ts,combos-postgres.e2e-spec.ts,combos-rabbitmq.e2e-spec.ts,combos-catalog-rabbitmq.e2e-spec.ts'
  fi
fi
export COMBOS_TEST_EXPECTED_SUITES="$expected_suites"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
docs_root="${COMBOS_TEST_DOCS_ROOT:-$(cd "$repo_root/../docs" && pwd)}"
catalog_migration="$docs_root/datos/catalog-svc/migrations/0001_create_catalog.sql"
combos_migration="$docs_root/datos/combos/migrations/0001_create_combos_persistence.sql"
combo_receipts_migration="$repo_root/apps/combos-svc/migrations/0002_create_combo_creation_receipts.sql"
pricing_migration="$repo_root/apps/pricing-svc/test/fixtures/pricing.sql"
pricing_official_migration="$docs_root/datos/pricing/migrations/0001_create_pricing.sql"
pricing_context_migration="$repo_root/apps/pricing-svc/migrations/0002_schedule_effective_events.sql"

required_migrations=("$combos_migration" "$combo_receipts_migration")
if [[ "$mode" == 'legacy' ]]; then
  required_migrations+=(
    "$catalog_migration"
    "$pricing_migration"
    "$pricing_official_migration"
    "$pricing_context_migration"
  )
fi
for migration in "${required_migrations[@]}"; do
  if [[ ! -f "$migration" ]]; then
    printf 'No se encontró la migración oficial: %s\n' "$migration" >&2
    exit 1
  fi
done
if [[ "$mode" == 'legacy' ]]; then
  if ! cmp -s <(tr -d '\r' < "$pricing_migration") <(tr -d '\r' < "$pricing_official_migration"); then
    printf 'La fixture Pricing no coincide con la migración oficial fijada.\n' >&2
    exit 1
  fi
fi

docker info --format '{{.ServerVersion}}' >/dev/null

if [[ -n "${COMBOS_TEST_EVIDENCE_DIR:-}" && -e "$COMBOS_TEST_EVIDENCE_DIR" ]]; then
  printf 'El directorio de evidencia ya existe; no se sobrescribirá: %s\n' "$COMBOS_TEST_EVIDENCE_DIR" >&2
  exit 1
fi

if [[ -r /proc/sys/kernel/random/uuid ]]; then
  harness_id="$(cat /proc/sys/kernel/random/uuid | tr -d '-')"
else
  harness_id="$(node -e 'process.stdout.write(require("node:crypto").randomUUID().replaceAll("-", ""))')"
fi
suffix="${harness_id:0:12}"
pg_container="g6-combos-it-$suffix"
rabbit_container="g6-combos-rabbit-it-$suffix"
harness_label='com.taller-sw.g6.combos-harness'
tmp_root="$(cd "${TMPDIR:-/tmp}" && pwd)"
tmp_dir="$(mktemp -d "$tmp_root/g6-combos-it-$harness_id.XXXXXX")"
tmp_dir="$(cd "$tmp_dir" && pwd)"
if [[ "$tmp_dir" != "$tmp_root"/* ]]; then
  printf 'Directorio temporal fuera del área permitida.\n' >&2
  exit 1
fi

pg_password="$(openssl rand -hex 24)"
catalog_password=''
pricing_password=''
rabbit_password=''
if [[ "$mode" == 'legacy' ]]; then
  catalog_password="$(openssl rand -hex 24)"
  pricing_password="$(openssl rand -hex 24)"
  rabbit_password="$(openssl rand -hex 24)"
fi

environment_names=(
  COMBOS_TEST_EPHEMERAL COMBOS_TEST_DATABASE_URL COMBOS_TEST_CA COMBOS_TEST_MODE
  COMBOS_TEST_RABBITMQ_URL COMBOS_TEST_RABBITMQ_CONTAINER
  COMBOS_TEST_CATALOG_PASSWORD COMBOS_TEST_PRICING_PASSWORD COMBOS_TEST_CWD
  COMBOS_TEST_EXPECTED_SUITES
  COMBOS_AMQP_ENABLED COMBOS_AMQP_URL G6_AMQP_CONNECT_IP
  MESSAGING_PROVIDER COMBOS_SERVICE_BUS_EVENTS_ENABLED SERVICE_BUS_NAMESPACE_FQDN
  AZURE_CLIENT_ID G6_SERVICE_BUS_PRODUCTION_ENABLED
  AZURE_SERVICE_BUS_ENABLED COMBOS_SERVICE_BUS_ENABLED SERVICE_BUS_ENABLED
  AZURE_SERVICE_BUS_NAMESPACE AZURE_SERVICE_BUS_FQDN AZURE_SERVICE_BUS_CONNECTION_STRING
  COMBOS_SERVICE_BUS_CONNECTION_STRING COMBOS_SERVICE_BUS_FQDN COMBOS_SERVICE_BUS_QUEUE
  DATABASE_URL
  PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD PGSSLMODE PGSSLROOTCERT
)
declare -A original_defined=()
declare -A original_value=()
for name in "${environment_names[@]}"; do
  if [[ -v $name ]]; then
    original_defined[$name]=1
    original_value[$name]="${!name}"
  else
    original_defined[$name]=0
  fi
done

restore_environment() {
  for name in "${environment_names[@]}"; do
    if [[ "${original_defined[$name]}" == 1 ]]; then
      export "$name=${original_value[$name]}"
    else
      unset "$name"
    fi
  done
}

remove_owned_container() {
  local name="$1"
  local exists label owner_id
  exists="$(docker inspect --format '{{.State.Running}}' "$name" 2>/dev/null || true)"
  [[ -n "$exists" ]] || return 0
  label="$(docker inspect --format '{{index .Config.Labels "com.taller-sw.g6.combos-harness"}}' "$name" 2>/dev/null || true)"
  owner_id="$(docker inspect --format '{{index .Config.Labels "com.taller-sw.g6.combos-harness-id"}}' "$name" 2>/dev/null || true)"
  if [[ "$label" == true && "$owner_id" == "$harness_id" ]]; then
    docker rm -f "$name" >/dev/null
  fi
}

cleanup() {
  local status=$?
  restore_environment
  remove_owned_container "$pg_container"
  if [[ "$mode" == 'legacy' ]]; then
    remove_owned_container "$rabbit_container"
  fi
  if [[ -n "${COMBOS_TEST_EVIDENCE_DIR:-}" ]]; then
    mkdir -p -- "$COMBOS_TEST_EVIDENCE_DIR"
    if [[ -n "${test_report:-}" && -f "$test_report" ]]; then
      cp -- "$test_report" "$COMBOS_TEST_EVIDENCE_DIR/vitest-results.json"
      node --input-type=module - "$test_report" "$COMBOS_TEST_EVIDENCE_DIR/run-summary.txt" "$COMBOS_TEST_EVIDENCE_DIR/run-environment.json" "$status" "$mode" "$docs_root" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const summaryPath = process.argv[3];
const envPath = process.argv[4];
const status = Number(process.argv[5]);
const mode = process.argv[6];
const docsRoot = process.argv[7];
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const tree = execFileSync('git', ['status', '--short'], { encoding: 'utf8' }).trimEnd();
let docsSha = 'unknown';
try {
  docsSha = execFileSync('git', ['-C', docsRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
} catch {
  docsSha = 'unavailable';
}
const suites = report.testResults?.map((result) => result.name.split(/[\\/]/).pop()) ?? [];
const environment = {
  result: status === 0 ? 'PASS' : 'FAIL',
  sha,
  docsSha,
  mode,
  postgresImage: 'postgres:17-alpine',
  tlsEnabled: true,
  rabbitmqStarted: mode === 'legacy',
  azureServiceBusEnabled: false,
  providers:
    mode === 'postgres-only'
      ? 'local-http-fixtures (Catalog/Pricing/Identity, non-production)'
      : 'legacy-isolated-catalog-pricing-rabbitmq',
  passed: report.numPassedTests,
  failed: report.numFailedTests,
  skipped: report.numPendingTests,
  todo: report.numTodoTests,
  suites,
};
writeFileSync(envPath, `${JSON.stringify(environment, null, 2)}\n`);
writeFileSync(summaryPath, [
  `result=${environment.result}`,
  `sha=${sha}`,
  `docs_sha=${docsSha}`,
  `mode=${mode}`,
  `rabbitmq_started=${environment.rabbitmqStarted}`,
  `azure_service_bus_enabled=${environment.azureServiceBusEnabled}`,
  `providers=${environment.providers}`,
  `passed=${report.numPassedTests}`,
  `failed=${report.numFailedTests}`,
  `skipped=${report.numPendingTests}`,
  `suites=${suites.join(',')}`,
  'working_tree_status:',
  tree,
  '',
].join('\n'));
NODE
      printf 'HARNESS_EVIDENCE: %s\n' "$COMBOS_TEST_EVIDENCE_DIR"
    fi
  fi
  case "$tmp_dir" in
    "$tmp_root"/g6-combos-it-"$harness_id".*) rm -rf -- "$tmp_dir" ;;
    *) printf 'Se preservó el directorio temporal por ruta inesperada: %s\n' "$tmp_dir" >&2 ;;
  esac
  exit "$status"
}
trap cleanup EXIT

diagnostics() {
  local name="$1"
  if docker inspect "$name" >/dev/null 2>&1; then
    printf 'Diagnóstico de %s (sin volcar configuración ni variables):\n' "$name" >&2
    docker inspect --format 'image={{.Config.Image}} running={{.State.Running}} oom={{.State.OOMKilled}} labels={{json .Config.Labels}}' "$name" >&2 || true
    local sed_args=(-e "s/$pg_password/[REDACTED]/g")
    [[ -n "$catalog_password" ]] && sed_args+=(-e "s/$catalog_password/[REDACTED]/g")
    [[ -n "$pricing_password" ]] && sed_args+=(-e "s/$pricing_password/[REDACTED]/g")
    [[ -n "$rabbit_password" ]] && sed_args+=(-e "s/$rabbit_password/[REDACTED]/g")
    docker logs --timestamps --tail 80 "$name" 2>&1 | sed "${sed_args[@]}" >&2 || true
  fi
}

on_error() {
  local code=$?
  printf 'HARNESS_FAILURE: línea=%s código=%s\n' "${BASH_LINENO[0]:-unknown}" "$code" >&2
  diagnostics "$pg_container"
  if [[ "$mode" == 'legacy' ]]; then
    diagnostics "$rabbit_container"
  fi
  return "$code"
}
trap on_error ERR

(
  umask 077
  openssl req -x509 -nodes -newkey rsa:2048 \
    -keyout "$tmp_dir/server.key" \
    -out "$tmp_dir/server.crt" \
    -days 1 \
    -subj '/CN=127.0.0.1' \
    -addext 'subjectAltName=IP:127.0.0.1' >/dev/null 2>&1
)
chmod 600 "$tmp_dir/server.key"
chmod 644 "$tmp_dir/server.crt"
docker run --rm --user root --volume "$tmp_dir:/cert" --entrypoint sh postgres:17-alpine -c \
  'chown 70:70 /cert/server.key /cert/server.crt && chmod 600 /cert/server.key && chmod 644 /cert/server.crt' >/dev/null
chmod 711 "$tmp_dir"

pg_server_options=(-c ssl=on -c ssl_cert_file=/cert/server.crt -c ssl_key_file=/cert/server.key)
if [[ "${G6_PERFORMANCE_HTTP:-}" == 1 ]]; then
  pg_server_options+=(-c shared_preload_libraries=pg_stat_statements)
fi
docker run --detach --name "$pg_container" \
  --label "$harness_label=true" \
  --label "com.taller-sw.g6.combos-harness-id=$harness_id" \
  --publish '127.0.0.1::5432' \
  --volume "$tmp_dir:/cert:ro" \
  --env "POSTGRES_PASSWORD=$pg_password" \
  --env POSTGRES_DB=combos_test \
  postgres:17-alpine postgres "${pg_server_options[@]}" >/dev/null

pg_ready=0
for _ in $(seq 1 60); do
  if docker exec "$pg_container" psql -U postgres -d combos_test -v ON_ERROR_STOP=1 \
    -c 'SELECT 1;' >/dev/null 2>&1; then
    pg_ready=1
    break
  fi
  sleep 1
done
if [[ "$pg_ready" != 1 ]]; then
  diagnostics "$pg_container"
  printf 'PostgreSQL 17 desechable no alcanzó readiness.\n' >&2
  exit 1
fi
if [[ "${G6_PERFORMANCE_HTTP:-}" == 1 ]]; then
  docker exec "$pg_container" psql -U postgres -d combos_test -v ON_ERROR_STOP=1 \
    -c 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements;' >/dev/null
fi
pg_port="$(docker port "$pg_container" 5432/tcp | awk -F: '{print $NF}')"
[[ "$pg_port" =~ ^[0-9]+$ ]]

rabbit_port=''
if [[ "$mode" == 'legacy' ]]; then
  docker run --detach --name "$rabbit_container" \
    --label "$harness_label=true" \
    --label "com.taller-sw.g6.combos-harness-id=$harness_id" \
    --publish '127.0.0.1::5672' \
    --env RABBITMQ_DEFAULT_USER=combos_test \
    --env "RABBITMQ_DEFAULT_PASS=$rabbit_password" \
    rabbitmq:4.2.9-alpine >/dev/null

  rabbit_ready=0
  for _ in $(seq 1 60); do
    if docker exec --user rabbitmq "$rabbit_container" rabbitmq-diagnostics -q check_running >/dev/null 2>&1 && \
      docker exec --user rabbitmq "$rabbit_container" rabbitmq-diagnostics -q check_port_connectivity >/dev/null 2>&1; then
      rabbit_ready=1
      break
    fi
    sleep 1
  done
  if [[ "$rabbit_ready" != 1 ]]; then
    diagnostics "$rabbit_container"
    printf 'RabbitMQ 4.2.9 desechable no alcanzó readiness.\n' >&2
    exit 1
  fi
  rabbit_port="$(docker port "$rabbit_container" 5672/tcp | awk -F: '{print $NF}')"
  [[ "$rabbit_port" =~ ^[0-9]+$ ]]
fi

if [[ "$mode" == 'postgres-only' ]]; then
  docker exec "$pg_container" psql -U postgres -d combos_test -v ON_ERROR_STOP=1 \
    -c "CREATE ROLE po_combos_owner NOLOGIN; CREATE SCHEMA combos AUTHORIZATION po_combos_owner;" >/dev/null
  {
    printf 'SET ROLE po_combos_owner;\n'
    cat "$combos_migration"
    cat "$combo_receipts_migration"
  } | docker exec -i "$pg_container" psql -U postgres -d combos_test -v ON_ERROR_STOP=1 -f - >/dev/null
else
  docker exec "$pg_container" psql -U postgres -d combos_test -v ON_ERROR_STOP=1 \
    -c "CREATE ROLE po_combos_owner NOLOGIN; CREATE ROLE po_catalog_owner NOLOGIN; CREATE ROLE po_pricing_owner NOLOGIN; CREATE ROLE catalog_app LOGIN PASSWORD '$catalog_password'; CREATE ROLE pricing_app LOGIN PASSWORD '$pricing_password'; CREATE SCHEMA combos AUTHORIZATION po_combos_owner; CREATE SCHEMA catalog AUTHORIZATION po_catalog_owner; CREATE SCHEMA pricing AUTHORIZATION po_pricing_owner; CREATE SCHEMA extensions; CREATE EXTENSION btree_gist WITH SCHEMA extensions; GRANT USAGE ON SCHEMA extensions TO po_pricing_owner;" >/dev/null

  for context in catalog combos; do
    if [[ "$context" == catalog ]]; then
      owner='po_catalog_owner'
      source_file="$catalog_migration"
    else
      owner='po_combos_owner'
      source_file="$combos_migration"
    fi
    {
      printf 'SET ROLE %s;\n' "$owner"
      cat "$source_file"
      if [[ "$context" == combos ]]; then cat "$combo_receipts_migration"; fi
    } | docker exec -i "$pg_container" psql -U postgres -d combos_test -v ON_ERROR_STOP=1 -f - >/dev/null
  done

  {
    printf 'SET ROLE po_pricing_owner;\n'
    cat "$pricing_migration"
    cat "$pricing_context_migration"
  } | docker exec -i "$pg_container" psql -U postgres -d combos_test -v ON_ERROR_STOP=1 -f - >/dev/null
fi

unset DATABASE_URL
export COMBOS_TEST_EPHEMERAL=1
export COMBOS_TEST_DATABASE_URL=harness-owned
export COMBOS_TEST_MODE="$mode"
export COMBOS_TEST_CA="$tmp_dir/server.crt"
export COMBOS_TEST_CWD="$tmp_dir"
export PGHOST=127.0.0.1 PGPORT="$pg_port" PGDATABASE=combos_test PGUSER=postgres PGPASSWORD="$pg_password"
export PGSSLMODE=verify-full PGSSLROOTCERT="$COMBOS_TEST_CA"

if [[ "$mode" == 'postgres-only' ]]; then
  export COMBOS_AMQP_ENABLED=false
  export COMBOS_SERVICE_BUS_EVENTS_ENABLED=false
  export G6_SERVICE_BUS_PRODUCTION_ENABLED=false
  unset COMBOS_AMQP_URL COMBOS_TEST_RABBITMQ_URL COMBOS_TEST_RABBITMQ_CONTAINER G6_AMQP_CONNECT_IP
  unset COMBOS_TEST_CATALOG_PASSWORD COMBOS_TEST_PRICING_PASSWORD
  unset MESSAGING_PROVIDER SERVICE_BUS_NAMESPACE_FQDN AZURE_CLIENT_ID
  unset AZURE_SERVICE_BUS_ENABLED COMBOS_SERVICE_BUS_ENABLED SERVICE_BUS_ENABLED
  unset AZURE_SERVICE_BUS_NAMESPACE AZURE_SERVICE_BUS_FQDN AZURE_SERVICE_BUS_CONNECTION_STRING
  unset COMBOS_SERVICE_BUS_CONNECTION_STRING COMBOS_SERVICE_BUS_FQDN COMBOS_SERVICE_BUS_QUEUE
else
  export COMBOS_TEST_CATALOG_PASSWORD="$catalog_password"
  export COMBOS_TEST_PRICING_PASSWORD="$pricing_password"
  export COMBOS_TEST_RABBITMQ_URL="amqp://combos_test:${rabbit_password}@127.0.0.1:${rabbit_port}/%2f"
  export COMBOS_TEST_RABBITMQ_CONTAINER="$rabbit_container"
fi

cd "$repo_root"
if [[ "$mode" == 'legacy' ]]; then
  npm run build:catalog-svc
  npm run build:pricing-svc
fi

if [[ -n "$test_file" ]]; then
  test_targets=("apps/combos-svc/test/$test_file")
else
  test_targets=(
    'apps/combos-svc/test/app.e2e-spec.ts'
    'apps/combos-svc/test/combos-postgres.e2e-spec.ts'
    'apps/combos-svc/test/combos-rabbitmq.e2e-spec.ts'
    'apps/combos-svc/test/combos-catalog-rabbitmq.e2e-spec.ts'
  )
fi
test_args=("${test_targets[@]}" --maxWorkers=1 --no-file-parallelism)
if [[ -n "$test_name_pattern" ]]; then
  test_args+=(--testNamePattern "$test_name_pattern")
fi
test_report="$tmp_dir/vitest-results.json"
test_args+=(--reporter=json "--outputFile=$test_report")
COMBOS_RUN_ISOLATED_E2E=1 npm run test:e2e -- "${test_args[@]}"
node --input-type=module - "$test_report" <<'NODE'
import { readFileSync } from 'node:fs';

const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const expected = process.env.COMBOS_TEST_EXPECTED_SUITES?.split(',') ?? [];
const reported = report.testResults?.map((result) => result.name.split(/[\\/]/).pop()) ?? [];
if (
  !Number.isInteger(report.numPassedTests) ||
  !Number.isInteger(report.numFailedTests) ||
  !Number.isInteger(report.numPendingTests) ||
  !Number.isInteger(report.numTodoTests) ||
  !Number.isInteger(report.numTotalTests) ||
  !Number.isInteger(report.numTotalTestSuites) ||
  !Number.isInteger(report.numPassedTestSuites) ||
  !Number.isInteger(report.numFailedTestSuites) ||
  !Number.isInteger(report.numPendingTestSuites) ||
  !Array.isArray(report.testResults) ||
  report.numPassedTests < 1 ||
  report.numFailedTests !== 0 ||
  report.numPendingTests !== 0 ||
  report.numTodoTests !== 0 ||
  report.numTotalTests !== report.numPassedTests + report.numFailedTests + report.numPendingTests + report.numTodoTests ||
  report.numTotalTestSuites < expected.length ||
  report.numPassedTestSuites !== report.numTotalTestSuites ||
  report.numFailedTestSuites !== 0 ||
  report.numPendingTestSuites !== 0 ||
  expected.length === 0 ||
  expected.length !== reported.length ||
  expected.some((suite) => reported.filter((name) => name === suite).length !== 1) ||
  report.testResults.some((result) => result.status !== 'passed')
) {
  process.stderr.write(
    'La suite E2E crítica quedó sin pruebas ejecutadas, con fallos o con pruebas omitidas.\n',
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `HARNESS_TEST_COUNTS: PASS passed=${report.numPassedTests} failed=${report.numFailedTests} skipped=${report.numPendingTests}\n`,
  );
}
NODE
