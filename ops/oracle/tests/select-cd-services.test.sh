#!/usr/bin/env bash
set -Eeuo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
readonly WORKFLOW="$ROOT/.github/workflows/cd-services-oracle.yml"
readonly REGISTRY="$ROOT/ops/oracle/services.psv"
readonly SELECTOR="$ROOT/ops/oracle/select-cd-services.sh"
readonly REGISTRY_SH="$ROOT/ops/oracle/service-registry.sh"

echo "=== Verificando Registro de Servicios ==="
# Versionado y formato del registro
header="$(head -n 1 "$REGISTRY")"
[[ "$header" == '#registry-version=2' ]] || { echo "FAIL: versión del registro no es 2: $header" >&2; exit 1; }
# shellcheck source=../service-registry.sh
source "$REGISTRY_SH"

# Exactamente 9 servicios registrados en total
total_services="$(awk -F'|' '$1 !~ /^#/ && NF { count++ } END { print count+0 }' "$REGISTRY")"
[[ "$total_services" == 9 ]] || { echo "FAIL: se esperaban 9 servicios, encontrados $total_services" >&2; exit 1; }

# Los 4 autorizados están habilitados en el registro
readonly -a EXPECTED_ENABLED=(api-gateway catalog-svc inventory-svc taxonomy-svc)
# Los 5 deshabilitados
readonly -a EXPECTED_DISABLED=(pricing-svc price-audit-svc promotions-svc combos-svc bulk-svc)

enabled_json="$(g6_enabled_services_json)"
expected_json='["api-gateway","catalog-svc","inventory-svc","taxonomy-svc"]'
[[ "$enabled_json" == "$expected_json" ]] || {
  echo "FAIL: servicios habilitados no coinciden. Obtenido: $enabled_json, Esperado: $expected_json" >&2
  exit 1
}
echo "PASS: los cuatro servicios autorizados están habilitados: $enabled_json"

# Para cada servicio habilitado, el dispatch manual selecciona exactamente un servicio
for svc in "${EXPECTED_ENABLED[@]}"; do
  output="$(bash "$SELECTOR" manual "$svc")"
  [[ "$output" == "[\"$svc\"]" ]] || {
    echo "FAIL: selección manual de $svc no devolvió [\"$svc\"]: $output" >&2
    exit 1
  }
done
echo "PASS: cada servicio habilitado es seleccionado individualmente mediante dispatch manual"

# Para cada servicio deshabilitado, el dispatch manual es rechazado con código 65
for svc in "${EXPECTED_DISABLED[@]}"; do
  set +e
  output="$(bash "$SELECTOR" manual "$svc" 2>&1)"
  status=$?
  set -e
  [[ "$status" == 65 ]] || {
    echo "FAIL: servicio deshabilitado $svc no devolvió código 65 (obtenido $status): $output" >&2
    exit 1
  }
  [[ "$output" =~ "Servicio registrado pero deshabilitado." ]] || {
    echo "FAIL: mensaje inesperado para servicio deshabilitado: $output" >&2
    exit 1
  }
done
echo "PASS: los cinco servicios deshabilitados son rechazados con código 65"

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
# 1. Ausencia de triggers automáticos: Push y Merge a master NO inician despliegue
# El bloque on: solo debe contener workflow_dispatch
workflow_on="$(sed -n '/^on:/,/^[a-z]/p' "$WORKFLOW" | head -n -1)"
if grep -Eq '^[[:space:]]*workflow_run:' <<< "$workflow_on"; then
  echo "FAIL: la sección on: contiene disparador workflow_run automático" >&2
  exit 1
fi
if grep -Eq '^[[:space:]]*push:' <<< "$workflow_on"; then
  echo "FAIL: la sección on: contiene disparador push" >&2
  exit 1
fi
if grep -Eq '^[[:space:]]*pull_request:' <<< "$workflow_on"; then
  echo "FAIL: la sección on: contiene disparador pull_request" >&2
  exit 1
fi
grep -Fq 'workflow_dispatch:' <<< "$workflow_on" || {
  echo "FAIL: la sección on: no declara workflow_dispatch" >&2
  exit 1
}
grep -Fq "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/master'" "$WORKFLOW" || {
  echo "FAIL: prepare job no restringe a workflow_dispatch en refs/heads/master" >&2
  exit 1
}
echo "PASS: CD Oracle carece de workflow_run, push o merge; exclusivo workflow_dispatch en master"

# 2. Invocación en modo automatic devuelve lista vacía [] y rechaza despliegues automáticos
auto_output="$(bash "$SELECTOR" automatic 2>&1)"
[[ "$auto_output" =~ "[]" ]] || {
  echo "FAIL: modo automatic no devolvió []: $auto_output" >&2
  exit 1
}
[[ "$auto_output" =~ "Despliegues automáticos deshabilitados" ]] || {
  echo "FAIL: modo automatic no informó que los despliegues automáticos están deshabilitados" >&2
  exit 1
}
echo "PASS: selector en modo automatic devuelve [] e informa deshabilitación"

# 3. CI fallida impide liberación
grep -Fq 'gh run list --repo "$GITHUB_REPOSITORY" --workflow ci.yml --branch master --commit "$sha"' "$WORKFLOW" || {
  echo "FAIL: falta consulta de CI push exitoso en master" >&2
  exit 1
}
grep -Fq 'No successful CI push run was found for master commit' "$WORKFLOW" || {
  echo "FAIL: falta mensaje y aborto ante CI no exitosa" >&2
  exit 1
}
echo "PASS: commit sin CI push exitosa en master impide la liberación"

# 4. SHA diferente al master vigente o inválido impide liberación
grep -Fq 'repos/${GITHUB_REPOSITORY}/commits/master' "$WORKFLOW" || {
  echo "FAIL: falta verificación de HEAD vigente de master" >&2
  exit 1
}
grep -Fq 'Skipping obsolete commit' "$WORKFLOW" || {
  echo "FAIL: falta descarte de commit obsoleto" >&2
  exit 1
}
grep -Fq '[[ "$sha" =~ ^[0-9a-f]{40}$ ]]' "$WORKFLOW" || {
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
for secret in ORACLE_HOST ORACLE_USER ORACLE_SSH_PRIVATE_KEY ORACLE_SSH_KNOWN_HOSTS ORACLE_GHCR_USERNAME ORACLE_GHCR_TOKEN; do
  grep -Fq "$secret" "$WORKFLOW" || {
    echo "FAIL: secreto obligatorio $secret ausente en validación" >&2
    exit 1
  }
done
grep -Fq 'Required GitHub Secret $name is not configured; Oracle CD is not activated.' "$WORKFLOW" || {
  echo "FAIL: falta mensaje de salida segura ante secretos faltantes" >&2
  exit 1
}
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
