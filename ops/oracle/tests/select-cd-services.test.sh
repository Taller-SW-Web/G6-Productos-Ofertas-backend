#!/usr/bin/env bash
set -Eeuo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
readonly WORKFLOW="$ROOT/.github/workflows/cd-services-oracle.yml"
readonly REGISTRY="$ROOT/ops/oracle/services.psv"
readonly SELECTOR="$ROOT/ops/oracle/select-cd-services.sh"
readonly REGISTRY_SH="$ROOT/ops/oracle/service-registry.sh"
readonly AUTO_AUTH="$ROOT/ops/oracle/auto-release-authorization.psv"
readonly SOURCE_VALIDATOR="$ROOT/ops/oracle/validate-cd-source.sh"

bash "$ROOT/ops/oracle/tests/validate-cd-source.test.sh"

echo "=== Verificando Registro de Servicios ==="
# Versionado y formato del registro
header="$(head -n 1 "$REGISTRY")"
[[ "$header" == '#registry-version=2' ]] || { echo "FAIL: versión del registro no es 2: $header" >&2; exit 1; }
# shellcheck source=../service-registry.sh
source "$REGISTRY_SH"

# Exactamente 9 servicios registrados en total
total_services="$(awk -F'|' '$1 !~ /^#/ && NF { count++ } END { print count+0 }' "$REGISTRY")"
[[ "$total_services" == 9 ]] || { echo "FAIL: se esperaban 9 servicios, encontrados $total_services" >&2; exit 1; }

# La decisión de infraestructura de Hito 3 habilita los nueve para dispatch
# manual; la preparación runtime y autorización de liberación siguen siendo gates.
readonly -a EXPECTED_ENABLED=(api-gateway bulk-svc catalog-svc combos-svc inventory-svc price-audit-svc pricing-svc promotions-svc taxonomy-svc)

enabled_json="$(g6_enabled_services_json)"
expected_json='["api-gateway","bulk-svc","catalog-svc","combos-svc","inventory-svc","price-audit-svc","pricing-svc","promotions-svc","taxonomy-svc"]'
[[ "$enabled_json" == "$expected_json" ]] || {
  echo "FAIL: servicios habilitados no coinciden. Obtenido: $enabled_json, Esperado: $expected_json" >&2
  exit 1
}
echo "PASS: los nueve servicios de Hito 3 están habilitados para dispatch manual: $enabled_json"

# Los nombres, puertos, proyectos, contenedores, estados y runtime files son únicos.
for field in 1 3 9 11 12 13; do
  awk -F'|' -v field="$field" '
    $1 !~ /^#/ && NF {
      value=$field
      if (value == "" || seen[value]++) invalid=1
      count++
    }
    END { exit (invalid || count != 9) }
  ' "$REGISTRY" || {
    echo "FAIL: campo de registro duplicado o incompleto: $field" >&2
    exit 1
  }
done
g6_service_config api-gateway
[[ "$G6_SERVICE_COMPOSE_FILE" == '/opt/g6-productos-ofertas/api-gateway/docker-compose.gateway.yml' ]] || {
  echo "FAIL: api-gateway no usa su Compose dedicado para g6-edge" >&2
  exit 1
}
echo "PASS: identidades/estado/runtime independientes y Compose dedicado de Gateway"

# Para cada servicio habilitado, el dispatch manual selecciona exactamente un servicio
for svc in "${EXPECTED_ENABLED[@]}"; do
  output="$(bash "$SELECTOR" manual "$svc")"
  [[ "$output" == "[\"$svc\"]" ]] || {
    echo "FAIL: selección manual de $svc no devolvió [\"$svc\"]: $output" >&2
    exit 1
  }
done
echo "PASS: cada servicio habilitado es seleccionado individualmente mediante dispatch manual"

# El selector automático usa autorización independiente, inicialmente vacía.
[[ "$(head -n 1 "$AUTO_AUTH")" == '#auto-release-authorization-version=1' ]]
[[ "$(awk -F'|' '$1 !~ /^#/ && NF && $2 == "false" { n++ } END { print n+0 }' "$AUTO_AUTH")" == 9 ]]
auto_output="$(bash "$SELECTOR" automatic example/g6-backend)"
[[ "$auto_output" == '[]' ]] || { echo "FAIL: el auto CD inicial no está vacío: $auto_output" >&2; exit 1; }

temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT
cp "$REGISTRY" "$REGISTRY_SH" "$SELECTOR" "$AUTO_AUTH" "$temp_dir/"
sed -i 's/^catalog-svc|false||$/catalog-svc|true|12345|https:\/\/github.com\/example\/g6-backend\/actions\/runs\/67890/' "$temp_dir/auto-release-authorization.psv"
single_auto="$(bash "$temp_dir/select-cd-services.sh" automatic example/g6-backend)"
[[ "$single_auto" == '["catalog-svc"]' ]] || { echo "FAIL: la autorización individual no aisló catalog-svc: $single_auto" >&2; exit 1; }
sed -i 's#catalog-svc|true|12345|https://github.com/example/g6-backend/actions/runs/67890#catalog-svc|true|12345|#' "$temp_dir/auto-release-authorization.psv"
set +e
bash "$temp_dir/select-cd-services.sh" automatic example/g6-backend >/dev/null 2>&1
auto_missing_evidence_status=$?
set -e
[[ "$auto_missing_evidence_status" == 65 ]] || { echo 'FAIL: la autorización sin evidencia readiness/smoke no se rechazó.' >&2; exit 1; }
echo 'PASS: autorización automática individual requiere liberación manual y evidencia readiness/smoke'

# Nombres inválidos son rechazados con código 64
for invalid in "unknown-svc" "catalogo" "inventario" "catalog-svc;id" "../../etc" "" " "; do
  set +e
  output="$(bash "$SELECTOR" manual "$invalid" 2>&1)"
  status=$?
  set -e
  [[ "$status" == 64 ]] || {
    echo "FAIL: entrada inválida '$invalid' no devolvió código 64: $status" >&2
    exit 1
  }
done
echo "PASS: nombres inválidos o no registrados son rechazados con código 64"

echo "=== Verificando Seguridad del CD Oracle ==="
# 1. Trigger automático solo a través de workflow_run de CI; conserva dispatch manual
workflow_on="$(sed -n '/^on:/,/^[a-z]/p' "$WORKFLOW" | head -n -1)"
if grep -Eq '^[[:space:]]*pull_request:' <<< "$workflow_on"; then
  echo "FAIL: el CD no debe dispararse directamente en pull_request" >&2
  exit 1
fi
grep -Fq 'workflow_run:' <<< "$workflow_on" || { echo 'FAIL: falta workflow_run'; exit 1; }
grep -Fq 'workflows: [CI]' <<< "$workflow_on" || { echo 'FAIL: workflow_run no está limitado a CI'; exit 1; }
grep -Fq 'workflow_dispatch:' <<< "$workflow_on" || {
  echo "FAIL: la sección on: no declara workflow_dispatch" >&2
  exit 1
}
grep -Fq 'connectivity-check' "$WORKFLOW" || { echo 'FAIL: falta modo de conectividad'; exit 1; }
grep -Fq "inputs.mode == 'connectivity-check'" "$WORKFLOW" || { echo 'FAIL: conectividad no tiene guard exclusivo'; exit 1; }
grep -Fq 'tailscale ping --c 1 --timeout=20s 100.87.22.28' "$WORKFLOW" || { echo 'FAIL: falta ping Tailscale al host aprobado'; exit 1; }
grep -Fq 'StrictHostKeyChecking=yes' "$WORKFLOW" || { echo 'FAIL: falta validación estricta SSH'; exit 1; }
grep -Fq 'SHA256:dVru76PK60yqZRYHUVtNNPUSYLtbS6ZE24mF0S/BhGY' "$WORKFLOW" || { echo 'FAIL: falta fingerprint aprobado'; exit 1; }
grep -Fq 'connectivity-probe' "$WORKFLOW" || { echo 'FAIL: falta probe inocuo'; exit 1; }
grep -Fq "inputs.mode == 'deploy'" "$WORKFLOW" || { echo 'FAIL: despliegue no está separado del modo conectividad'; exit 1; }
grep -Fq "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/master'" "$WORKFLOW" || {
  echo "FAIL: el disparador manual no está restringido a refs/heads/master" >&2
  exit 1
}
for guard in 'CI_EVENT:-' 'CI_BRANCH:-' 'CI_CONCLUSION:-' 'CI_HEAD_REPOSITORY' 'CI_SHA' 'Skipping obsolete commit'; do
  grep -Fq "$guard" "$SOURCE_VALIDATOR" || { echo "FAIL: falta validación de evento CI $guard" >&2; exit 1; }
done
grep -Fq 'run: bash ops/oracle/validate-cd-source.sh' "$WORKFLOW" || { echo 'FAIL: workflow no ejecuta el validador probado'; exit 1; }
grep -Fq 'tailscale/github-action@d1b6cd204f8dceda5b3eaad7f1f767be390056cd' "$WORKFLOW" || { echo 'FAIL: falta Tailscale OIDC'; exit 1; }
grep -Fq 'tailscale ping --c 1 --timeout=20s "$ORACLE_HOST"' "$WORKFLOW" || { echo 'FAIL: ORACLE_HOST no se verifica como peer Tailscale'; exit 1; }
grep -Fq 'id-token: write' "$WORKFLOW" || { echo 'FAIL: falta permiso OIDC'; exit 1; }
echo "PASS: workflow_run validado y workflow_dispatch manual preservado; Tailscale usa OIDC"

# 2. Invocación en modo automatic devuelve lista vacía [] y rechaza despliegues automáticos
auto_output="$(bash "$SELECTOR" automatic example/g6-backend 2>&1)"
[[ "$auto_output" =~ "[]" ]] || {
  echo "FAIL: modo automatic no devolvió []: $auto_output" >&2
  exit 1
}
echo "PASS: modo automatic devuelve [] mientras los nueve servicios están deshabilitados"

# 3. CI fallida impide liberación
grep -Fq 'gh run list --repo "$repository" --workflow ci.yml --branch master --commit "$sha"' "$SOURCE_VALIDATOR" || {
  echo "FAIL: falta consulta de CI push exitoso en master" >&2
  exit 1
}
grep -Fq 'No successful CI push run was found for master commit' "$SOURCE_VALIDATOR" || {
  echo "FAIL: falta mensaje y aborto ante CI no exitosa" >&2
  exit 1
}
echo "PASS: commit sin CI push exitosa en master impide la liberación"

# 4. SHA diferente al master vigente o inválido impide liberación
grep -Fq 'repos/${repository}/commits/master' "$SOURCE_VALIDATOR" || {
  echo "FAIL: falta verificación de HEAD vigente de master" >&2
  exit 1
}
grep -Fq 'Skipping obsolete commit' "$SOURCE_VALIDATOR" || {
  echo "FAIL: falta descarte de commit obsoleto" >&2
  exit 1
}
grep -Fq '^[0-9a-f]{40}$' "$SOURCE_VALIDATOR" || {
  echo "FAIL: falta validación estricta de formato SHA de 40 caracteres" >&2
  exit 1
}
grep -Fq 'Confirm commit is still the master head' "$WORKFLOW" || {
  echo "FAIL: falta re-verificación de frescura de master antes de SSH" >&2
  exit 1
}
echo "PASS: SHA obsoleto, desactualizado o con formato inválido impide la liberación"

# 5. Secretos faltantes: fallo seguro, sin despliegue
grep -Fq 'Validate deployment secrets' "$WORKFLOW" || {
  echo "FAIL: falta paso Validate deployment secrets" >&2
  exit 1
}
for secret in ORACLE_HOST ORACLE_USER ORACLE_SSH_PRIVATE_KEY ORACLE_SSH_KNOWN_HOSTS ORACLE_GHCR_USERNAME ORACLE_GHCR_TOKEN TS_OIDC_CLIENT_ID TS_OIDC_AUDIENCE; do
  grep -Fq "$secret" "$WORKFLOW" || {
    echo "FAIL: secreto obligatorio $secret ausente en validación" >&2
    exit 1
  }
done
grep -Fq 'Required GitHub secret/variable $name is not configured; Oracle CD stopped before publication.' "$WORKFLOW" || {
  echo "FAIL: falta mensaje de salida segura ante secretos faltantes" >&2
  exit 1
}
validation_line="$(grep -n 'name: Validate deployment secrets and Tailscale variables' "$WORKFLOW" | cut -d: -f1)"
publish_line="$(grep -n 'name: Build and publish image tagged with the SHA' "$WORKFLOW" | cut -d: -f1)"
((validation_line < publish_line)) || { echo 'FAIL: se publicaría antes de validar secretos/OIDC.' >&2; exit 1; }
echo "PASS: ejecución fail-closed garantizada si faltan secretos"

# 6. Controles SSH, Deployments API y Rollback
grep -Fq 'ssh -vv -i ~/.ssh/oracle_g6 -o BatchMode=yes -o IdentitiesOnly=yes' "$WORKFLOW" || {
  echo "FAIL: falta probe restringido SSH" >&2
  exit 1
}
grep -Fq 'comando remoto no autorizado' "$WORKFLOW" || {
  echo "FAIL: falta verificación del comando remoto forzado en SSH" >&2
  exit 1
}
grep -Fq 'github-deployment-api.sh create' "$WORKFLOW" || {
  echo "FAIL: falta registro de inicio de Deployment" >&2
  exit 1
}
grep -Fq 'github-deployment-api.sh status "$GITHUB_REPOSITORY" "$DEPLOYMENT_ID" success' "$WORKFLOW" || {
  echo "FAIL: falta registro de éxito en Deployment tras SSH" >&2
  exit 1
}
grep -Fq 'github-deployment-api.sh status "$GITHUB_REPOSITORY" "$DEPLOYMENT_ID" failure' "$WORKFLOW" || {
  echo "FAIL: falta registro de fallo en Deployment" >&2
  exit 1
}
deploy_line="$(grep -n 'name: Deploy image, check health and roll back on failure' "$WORKFLOW" | cut -d: -f1)"
success_line="$(grep -n 'name: Record successful deployment after remote health checks' "$WORKFLOW" | cut -d: -f1)"
((success_line > deploy_line)) || {
  echo "FAIL: éxito se registraría antes de completar el despliegue remoto" >&2
  exit 1
}
echo "PASS: pipeline SSH, healthchecks, deployments y rollback estructurados correctamente"
