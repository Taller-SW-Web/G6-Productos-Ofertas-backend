#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
WORKFLOW="$ROOT/.github/workflows/cd-services-azure.yml"
CI_WORKFLOW="$ROOT/.github/workflows/ci.yml"
fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
for required in 'workflow_dispatch:' 'brazil-isolated' 'chile-shared' 'azure-h5-chile' 'azure-h5-pilot-234' 'PILOT_SELF_REVIEW_SCOPE_REJECTED' 'id-token: write' 'cancel-in-progress: false' 'max-parallel: 1' 'packages: write' 'azure/login@v2' 'container-apps/deploy.sh' 'smoke-service.sh' 'reconcile-recovery.sh' 'g6-azure-h5-' 'publish-g6-ghcr-' 'ops/shared/ensure-ghcr-sha-image.sh'; do
  grep -Fq "$required" "$WORKFLOW" || fail "falta $required"
done
grep -Fq 'default: brazil-isolated' "$WORKFLOW" || fail 'Brazil no se conserva como destino por defecto'
grep -Fq 'resolve-deployment-target.sh' "$WORKFLOW" || fail 'falta validación explícita del destino'
grep -Fq 'g5-labelled' "$WORKFLOW" || fail 'falta perfil etiquetado G5'
grep -Fq 'G5_LABELLED_ROUTE_SCOPE_REJECTED' "$WORKFLOW" || fail 'perfil G5 no queda limitado a Chile/api-gateway'
grep -Fq 'H5_GATEWAY_ROUTE_PROFILE' "$WORKFLOW" || fail 'perfil no llega a deploy/smoke protegidos'
grep -Fq 'GATEWAY_G5_H5_ENABLED=true' "$ROOT/ops/azure/container-apps/deploy.sh" || fail 'flag H5 no se fija en revisión Gateway etiquetada'
grep -Fq 'revision label add' "$ROOT/ops/azure/container-apps/deploy.sh" || fail 'no se asigna etiqueta ACA a revisión Gateway'
grep -Fq 'marketplace_traffic_weight' "$ROOT/ops/azure/container-apps/smoke-service.sh" || fail 'smoke no prueba que el tráfico Marketplace permanezca separado'
grep -Fq 'AZURE_CHILE_DEPLOY_ENABLED' "$WORKFLOW" || fail 'falta gate de habilitación Chile desde vars del job deploy'
grep -Fq 'AZURE_CHILE_DEPLOY_ENABLED' "$ROOT/ops/azure/container-apps/deploy.sh" || fail 'el ejecutor no exige el gate Chile'
if grep -Fq '/variables/AZURE_CHILE_DEPLOY_ENABLED' "$ROOT/ops/azure/container-apps/verify-environment-protection.sh"; then fail 'el verificador usa endpoint REST de variables'; fi
if grep -Eq '^[[:space:]]+workflow_run:' "$WORKFLOW"; then fail 'CD no debe desplegar automáticamente'; fi
if grep -Fq 'ops/oracle/' "$WORKFLOW"; then fail 'CD Azure conserva dependencia operativa Oracle'; fi
grep -Fq "github.repository == 'Taller-SW-Web/G6-Productos-Ofertas-backend'" "$WORKFLOW" || fail 'repositorio oficial no fijado'
grep -Fq 'ops/azure/container-apps/validate-source.sh' "$WORKFLOW" || fail 'validación de procedencia ausente'
grep -Fq 'actions: read' "$WORKFLOW" || fail 'lectura de ejecuciones CI ausente'
grep -Fq 'AZURE_SMOKE_PROTECTED_CATALOG_SVC' "$WORKFLOW" || fail 'smoke de rechazo sin credenciales no configurable'
grep -Fq 'needs: [prepare, security]' "$WORKFLOW" || fail 'publicación no depende del gate de seguridad'
grep -Fq 'npm audit --omit=dev --audit-level=high' "$WORKFLOW" || fail 'gate obligatorio de auditoría de producción ausente'
grep -Fq 'verify-environment-protection.sh' "$WORKFLOW" || fail 'preflight de protección del environment ausente'
grep -Fq 'verify-environment-protection.test.sh' "$CI_WORKFLOW" || fail 'CI no prueba la protección real del environment'
if ! grep -Fq 'self-hosted, linux,' "$WORKFLOW" || ! grep -Fq 'needs.prepare.outputs.runner_label' "$WORKFLOW"; then
  fail 'smoke no elige etiqueta privada según destino'
fi
grep -Fq -- '- azure-h5-smoke' "$ROOT/.github/actionlint.yaml" || fail 'actionlint no conoce la etiqueta privada del runner smoke'
prepare_gate_line="$(grep -nF 'Preflight read-only de protección del Environment antes de publicar' "$WORKFLOW" | cut -d: -f1)"
security_job_line="$(grep -n '^  security:' "$WORKFLOW" | cut -d: -f1)"
publish_job_line="$(grep -n '^  publish:' "$WORKFLOW" | cut -d: -f1)"
[[ -n "$prepare_gate_line" && -n "$security_job_line" && -n "$publish_job_line" && "$prepare_gate_line" -lt "$security_job_line" && "$security_job_line" -lt "$publish_job_line" ]] || fail 'preflight del environment no bloquea antes de GHCR'
deploy_gate_line="$(grep -nFx '      - name: Revalidar reglas reales del environment inmediatamente antes de OIDC' "$WORKFLOW" | cut -d: -f1)"
deploy_login_line="$(grep -nFx '      - name: Autenticar en Azure mediante OIDC' "$WORKFLOW" | cut -d: -f1)"
recovery_gate_line="$(grep -nF 'Revalidar reglas reales del environment inmediatamente antes de OIDC para recuperación' "$WORKFLOW" | cut -d: -f1)"
recovery_login_line="$(grep -nF 'Autenticar en Azure mediante OIDC para recuperación' "$WORKFLOW" | head -n 1 | cut -d: -f1)"
[[ -n "$deploy_gate_line" && -n "$deploy_login_line" && "$deploy_gate_line" -lt "$deploy_login_line" ]] || fail 'el deploy autentica antes de revalidar protección'
operational_gate_line="$(grep -nFx '      - name: Exigir ventana Chile abierta después de la aprobación' "$WORKFLOW" | cut -d: -f1)"
[[ -n "$operational_gate_line" && "$deploy_gate_line" -lt "$operational_gate_line" && "$operational_gate_line" -lt "$deploy_login_line" ]] || fail 'el gate de ventana no está entre la aprobación/protección y OIDC'
[[ -n "$recovery_gate_line" && -n "$recovery_login_line" && "$recovery_gate_line" -lt "$recovery_login_line" ]] || fail 'la recuperación autentica antes de verificar protección'
next_step_after_recovery_gate="$(awk -v gate="$recovery_gate_line" 'NR > gate && /- name: / { print NR; exit }' "$WORKFLOW")"
[[ "$next_step_after_recovery_gate" == "$recovery_login_line" ]] || fail 'la revalidación de recuperación no es inmediatamente anterior a OIDC'
for forbidden in 'AZURE_CLIENT_SECRET' 'AZURE_PASSWORD' 'ARM_CLIENT_SECRET' ':latest' 'az containerapp create' 'az containerapp delete'; do
  if grep -Fq "$forbidden" "$WORKFLOW"; then fail "capacidad/credencial prohibida: $forbidden"; fi
done
for service in api-gateway bulk-svc catalog-svc combos-svc inventory-svc price-audit-svc pricing-svc promotions-svc taxonomy-svc; do
  grep -Fq -- "- $service" "$WORKFLOW" || fail "faltó el servicio $service"
  service_key="${service^^}"
  service_key="${service_key//-/_}"
  grep -Fq "SMOKE_URL_${service_key}" "$WORKFLOW" || fail "faltó la variable smoke de $service"
done
grep -Fq 'DEPLOY_RECEIPT' "$ROOT/ops/azure/container-apps/deploy.sh" || fail 'recibo para recuperación coordinada ausente'
grep -Fq 'Descargar recibo del mismo servicio y run' "$WORKFLOW" || fail 'smoke no descarga recibo de su servicio/run'
grep -Fq 'served_digest' "$ROOT/ops/azure/container-apps/smoke-service.sh" || fail 'smoke no valida revisión/digest efectivamente servidos'
grep -Fq -- '--restore' "$ROOT/ops/azure/container-apps/deploy.sh" || fail 'modo de recuperación por digest ausente'
grep -Fq 'select(.name == "caddy")' "$ROOT/ops/azure/container-apps/deploy.sh" || fail 'identidad efectiva Caddy no validada'
grep -Fq 'del(.revisionSuffix)' "$ROOT/ops/azure/container-apps/deploy.sh" || fail 'metadato revisionSuffix no normalizado'
grep -Fq 'containerApps/write' "$ROOT/ops/azure/container-apps/CONFIGURACION_OIDC_H5.md" || fail 'límite del permiso genérico write no documentado'
grep -Fq 'azure_cd_h5:' "$CI_WORKFLOW" || fail 'pruebas de ejecutor H5 no conectadas a CI'
for test_file in validate-source.test.sh deployment-targets.test.sh verify-environment-protection.test.sh deploy.test.sh smoke.test.sh reconcile-recovery.test.sh workflow.test.sh; do
  grep -Fq "ops/azure/container-apps/tests/$test_file" "$CI_WORKFLOW" || fail "CI no ejecuta $test_file"
done
for h5_test in \
  ops/azure/tests/h5-cd/check-workflow-evidence.sh \
  ops/azure/tests/h5-cd/verify-release-evidence.test.mjs \
  ops/azure/tests/h5-cd/preflight.test.mjs \
  ops/azure/service-bus/summarize-observations.test.mjs \
  ops/azure/tests/h5-rl/verify-rate-limit.test.mjs; do
  grep -Fq "$h5_test" "$CI_WORKFLOW" || fail "CI obligatorio no ejecuta $h5_test"
done
grep -Fq 'ops/shared/tests/ensure-ghcr-sha-image.test.sh' "$CI_WORKFLOW" || fail 'CI no prueba el helper neutral de GHCR'
printf 'PASS: CD Azure H5 es manual, aplica gates explícitos, no depende de Oracle y cubre nueve servicios\n'
