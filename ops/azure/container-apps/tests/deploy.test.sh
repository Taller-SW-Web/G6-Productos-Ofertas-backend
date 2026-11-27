#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
readonly ROOT
readonly DEPLOY="$ROOT/ops/azure/container-apps/deploy.sh"
TEMP="$(mktemp -d)"
readonly TEMP
readonly PREVIOUS='ghcr.io/taller-sw-web/g6-productos-ofertas-backend/api-gateway@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
readonly TARGET='ghcr.io/taller-sw-web/g6-productos-ofertas-backend/api-gateway@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
readonly PROMO_PREVIOUS='ghcr.io/taller-sw-web/g6-productos-ofertas-backend/promotions-svc@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
readonly PROMO_TARGET='ghcr.io/taller-sw-web/g6-productos-ofertas-backend/promotions-svc@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
readonly BRAZIL_TARGET='ghcr.io/taller-sw-web/g6-productos-ofertas-backend/api-gateway@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
trap 'rm -rf "$TEMP"' EXIT
mkdir "$TEMP/bin"
cat > "$TEMP/state.json" <<EOF
{"properties":{"configuration":{"activeRevisionsMode":"Multiple","secrets":[{"name":"ACA_PRIVATE_SENTINEL","value":"must-not-be-printed"}],"ingress":{"external":true,"targetPort":3000,"traffic":[{"revisionName":"rev-0","weight":100}]}},"template":{"revisionSuffix":"initial","containers":[{"name":"api-gateway","image":"$PREVIOUS","env":[{"name":"PRIVATE_SETTING","value":"must-not-be-printed"}]},{"name":"caddy","image":"ghcr.io/taller-sw-web/caddy@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}],"scale":{"minReplicas":1,"maxReplicas":1}},"latestRevisionName":"rev-0","latestReadyRevisionName":"rev-0"},"revision":{"properties":{"healthState":"Healthy","active":true,"runningState":"Running","replicas":1,"provisioningState":"Provisioned","template":{"containers":[{"name":"api-gateway","image":"$PREVIOUS","env":[{"name":"PRIVATE_SETTING","value":"must-not-be-printed"}]},{"name":"caddy","image":"ghcr.io/taller-sw-web/caddy@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}],"scale":{"minReplicas":1,"maxReplicas":1}}}},"updates":0,"trafficSetCount":0}
EOF
cat > "$TEMP/bin/az" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
state="${MOCK_STATE:?}"
service="${MOCK_SERVICE:-api-gateway}"
subscription='fef42188-accd-4470-ae88-78f583eb4906'
[[ "${MOCK_BAD_SUBSCRIPTION:-false}" != true ]] || subscription='00000000-0000-0000-0000-000000000000'
group="${MOCK_RESOURCE_GROUP:-rg-g6-aca-chile}"
aca_env='env-g6-phase1-chile'
location='chilecentral'
if [[ "$group" == rg-g6-sb-h5-int-fork ]]; then aca_env='env-g6-h5-int'; location='brazilsouth'; fi
env_id="/subscriptions/$subscription/resourceGroups/$group/providers/Microsoft.App/managedEnvironments/$aca_env"
app_id="/subscriptions/$subscription/resourceGroups/$group/providers/Microsoft.App/containerApps/$service"
if [[ "${1:-}" == account && "${2:-}" == show ]]; then printf '%s\n' "$subscription"; exit 0; fi
if [[ "${1:-}" == containerapp ]]; then [[ "$*" == *"--resource-group ${MOCK_RESOURCE_GROUP:-rg-g6-aca-chile}"* ]] || { echo 'wrong resource group' >&2; exit 61; }; fi
if [[ "${1:-}" == group && "${2:-}" == show ]]; then printf '{"id":"/subscriptions/%s/resourceGroups/%s"}\n' "$subscription" "$group"; exit 0; fi
if [[ "${1:-}" == containerapp && "${2:-}" == env && "${3:-}" == show ]]; then [[ "${MOCK_BAD_ENVIRONMENT:-false}" != true ]] || env_id="$env_id-wrong"; printf '{"id":"%s","location":"%s"}\n' "$env_id" "$location"; exit 0; fi
if [[ "${1:-}" == containerapp && "${2:-}" == show ]]; then
  jq --arg id "$app_id" --arg env "$env_id" --arg service "$service" --arg traffic "${MOCK_TRAFFIC:-state}" '. + {id:$id} | .properties.managedEnvironmentId=$env | .properties.configuration.ingress.fqdn=($service+".internal.chilecentral.azurecontainerapps.io") | .properties.configuration.ingress.allowInsecure=false | if $traffic == "old" then .properties.configuration.ingress.traffic=[{revisionName:"rev-0",weight:100}] elif $traffic == "ambiguous" then .properties.configuration.ingress.traffic=[{latestRevision:true,weight:50},{revisionName:"rev-0",weight:50}] elif $traffic == "old-after-rollback" and .updates >= 2 then .properties.configuration.ingress.traffic=[{revisionName:"rev-0",weight:100}] else . end' "$state"
  exit 0
fi
if [[ "${1:-}" == containerapp && "${2:-}" == revision && "${3:-}" == show ]]; then
  requested=''
  while (($#)); do [[ "$1" != --revision ]] || { shift; requested="$1"; }; shift || true; done
  jq -c --arg requested "$requested" --arg startup "${MOCK_STARTUP:-false}" '(.revisionPolls += 1) | if $startup == "true" and .revisionPolls == 1 then .revision.properties.runningState="Processing" elif $startup == "true" and .revisionPolls >= 2 then .revision.properties.runningState="Running" else . end | if .previousRevisionName == $requested then .previousRevision else .revision end' "$state"
  jq --arg startup "${MOCK_STARTUP:-false}" '(.revisionPolls += 1) | if $startup == "true" and .revisionPolls == 1 then .revision.properties.runningState="Processing" elif $startup == "true" and .revisionPolls >= 2 then .revision.properties.runningState="Running" else . end' "$state" > "$state.tmp"
  mv "$state.tmp" "$state"
  exit 0
fi
if [[ "${1:-}" == containerapp && "${2:-}" == ingress && "${3:-}" == traffic && "${4:-}" == set ]]; then
  [[ "${MOCK_TRAFFIC_SET_FAIL:-false}" != true ]] || exit 65
  jq '.trafficSetCount += 1' "$state" > "$state.tmp"
  mv "$state.tmp" "$state"
  [[ "${MOCK_TRAFFIC_SET_FAIL_ON:-0}" != "$(jq -r .trafficSetCount "$state")" ]] || exit 65
  revision_weight=''
  while (($#)); do [[ "$1" != --revision-weight ]] || { shift; revision_weight="$1"; }; shift || true; done
  revision="${revision_weight%=100}"
  [[ -n "$revision" && "$revision_weight" == "$revision=100" ]] || exit 66
  jq --arg revision "$revision" '.properties.configuration.ingress.traffic=[{revisionName:$revision,weight:100}]' "$state" > "$state.tmp"
  mv "$state.tmp" "$state"
  exit 0
fi
if [[ "${1:-}" == containerapp && "${2:-}" == update ]]; then
  [[ "$*" == *"--container-name $service"* ]] || { echo 'container name missing' >&2; exit 62; }
  image=''
  while (($#)); do [[ "$1" != --image ]] || { shift; image="$1"; }; shift || true; done
  [[ -n "$image" ]] || exit 63
  jq --arg image "$image" --arg service "$service" --arg unhealthy_target "${MOCK_UNHEALTHY_TARGET:-}" --arg unhealthy_rollback "${MOCK_UNHEALTHY_ROLLBACK:-false}" --arg scale_zero "${MOCK_SCALE_ZERO:-false}" --arg concurrent_traffic "${MOCK_CONCURRENT_TRAFFIC:-}" '
    .previousRevision = .revision |
    .previousRevisionName = .properties.latestRevisionName |
    .updates += 1 |
    .properties.template.containers |= map(if .name == $service then .image=$image else . end) |
    .properties.latestRevisionName = ("rev-" + (.updates|tostring)) |
    .properties.latestReadyRevisionName = .properties.latestRevisionName |
    .properties.template.revisionSuffix = ("revision-" + (.updates|tostring)) |
    .revision.properties.template = .properties.template |
    .revisionPolls = 0 |
    .revision.properties.replicas = (if $scale_zero == "true" then 0 else 1 end) |
    .revision.properties.provisioningState = "Provisioned" |
    .revision.properties.healthState = (if $image == $unhealthy_target or ($unhealthy_rollback == "true" and ($image | contains("@sha256:aaaaaaaa"))) then "Unhealthy" elif $scale_zero == "true" then "None" else "Healthy" end) |
    .revision.properties.runningState = (if $image == $unhealthy_target or ($unhealthy_rollback == "true" and ($image | contains("@sha256:aaaaaaaa"))) then "Failed" elif $scale_zero == "true" then "ScaledToZero" else "Running" end) |
    if $concurrent_traffic != "" then .properties.configuration.ingress.traffic=[{revisionName:$concurrent_traffic,weight:100}] else . end
  ' "$state" > "$state.tmp"
  mv "$state.tmp" "$state"
  exit 0
fi
if [[ "${1:-}" == containerapp && "${2:-}" == revision && "${3:-}" == label && "${4:-}" == add ]]; then
  jq '.g5_label=true | .properties.configuration.ingress.traffic=[{revisionName:.marketplace_revision,weight:100},{label:"g5-h5",revisionName:.properties.latestRevisionName,weight:0}]' "$state" > "$state.tmp"
  mv "$state.tmp" "$state"
  exit 0
fi
if [[ "${1:-}" == containerapp && "${2:-}" == revision && "${3:-}" == label && "${4:-}" == remove ]]; then
  jq '.g5_label=false | .properties.configuration.ingress.traffic=[{revisionName:.marketplace_revision,weight:100}]' "$state" > "$state.tmp"
  mv "$state.tmp" "$state"
  exit 0
fi
exit 64
MOCK
chmod +x "$TEMP/bin/az"
export PATH="$TEMP/bin:$PATH" MOCK_STATE="$TEMP/state.json" ACA_POLL_ATTEMPTS=2 ACA_POLL_INTERVAL_SECONDS=0
export DEPLOY_RECEIPT="$TEMP/gateway.receipt"
export GITHUB_RUN_ID=12345
export H5_DEPLOY_ENVIRONMENT=azure-h5-chile
export H5_DEPLOY_DESTINATION=chile-shared H5_PILOT_SELF_REVIEW=false
fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

if bash "$DEPLOY" bad-service "$TARGET" >/dev/null 2>&1; then fail 'servicio no autorizado'; fi
if bash "$DEPLOY" api-gateway "${TARGET%api-gateway@*}catalog-svc@${TARGET##*@}" >/dev/null 2>&1; then fail 'imagen de otro servicio'; fi
if bash "$DEPLOY" api-gateway "${TARGET%@*}" >/dev/null 2>&1; then fail 'imagen sin digest'; fi
printf 'PASS: rechaza servicio, paquete cruzado e imagen sin digest\n'
updates_before_gate="$(jq -r .updates "$MOCK_STATE")"
if env -u AZURE_CHILE_DEPLOY_ENABLED bash "$DEPLOY" api-gateway "$TARGET" >/dev/null 2>&1; then fail 'Chile deploy without operational gate'; fi
for gate in false TRUE; do
  if AZURE_CHILE_DEPLOY_ENABLED="$gate" bash "$DEPLOY" api-gateway "$TARGET" >/dev/null 2>&1; then fail "Chile deploy accepted gate '$gate'"; fi
done
[[ "$(jq -r .updates "$MOCK_STATE")" == "$updates_before_gate" ]] || fail 'Chile deploy gate failure modified ACA'
export AZURE_CHILE_DEPLOY_ENABLED=true
echo 'PASS: Chile deploy rejects missing/false/TRUE gate before any Azure mutation'
MOCK_RESOURCE_GROUP=rg-g6-sb-h5-int-fork H5_DEPLOY_ENVIRONMENT=azure-h5 H5_DEPLOY_DESTINATION=brazil-isolated H5_PILOT_SELF_REVIEW=false \
  bash "$DEPLOY" --inspect api-gateway "$PREVIOUS" > "$TEMP/isolated.log" 2>&1 ||
  { cat "$TEMP/isolated.log"; fail 'azure-h5 no consultó su grupo aislado'; }
if H5_DEPLOY_ENVIRONMENT=production bash "$DEPLOY" --inspect api-gateway "$PREVIOUS" >/dev/null 2>&1; then
  fail 'acepta un environment fuera de la allowlist'
fi
if H5_DEPLOY_ENVIRONMENT='' bash "$DEPLOY" --inspect api-gateway "$PREVIOUS" >/dev/null 2>&1; then
  fail 'acepta un environment ausente'
fi
printf 'PASS: azure-h5 usa su destino aislado y el ejecutor rechaza otros environments\n'

updates_before_validation="$(jq -r .updates "$MOCK_STATE")"
if MOCK_BAD_SUBSCRIPTION=true bash "$DEPLOY" api-gateway "$TARGET" >/dev/null 2>&1; then fail 'acepta otra suscripción'; fi
if MOCK_BAD_ENVIRONMENT=true bash "$DEPLOY" api-gateway "$TARGET" >/dev/null 2>&1; then fail 'acepta ACA de otro Environment'; fi
[[ "$(jq -r .updates "$MOCK_STATE")" == "$updates_before_validation" ]] || fail 'validación de destino fallida modificó ACA'
echo 'PASS: suscripción/Environment incorrectos fallan antes de cualquier actualización'

if bash "$DEPLOY" api-gateway "$TARGET" > "$TEMP/deploy.log" 2>&1; then :; else cat "$TEMP/deploy.log"; fail 'despliegue esperado'; fi
grep -Fq 'modo=running réplicas=1 salud=Healthy' "$TEMP/deploy.log" || fail 'arranque Processing→Running no se verificó'
jq -e --arg target "$TARGET" '.properties.template.containers[] | select(.name == "api-gateway") | .image == $target' "$MOCK_STATE" >/dev/null || fail 'imagen objetivo no aplicada'
jq -e '.properties.template.containers[] | select(.name == "caddy") | .image | contains("cccccccc")' "$MOCK_STATE" >/dev/null || fail 'caddy no conservado'
jq -e '.properties.configuration.ingress.external == true and .properties.configuration.secrets[0].value == "must-not-be-printed" and .properties.template.scale.maxReplicas == 1' "$MOCK_STATE" >/dev/null || fail 'configuración ACA no conservada'
if grep -Fq 'must-not-be-printed' "$TEMP/deploy.log"; then fail 'se imprimió configuración privada'; fi
printf 'PASS: actualiza con sidecar caddy en minúscula y conserva imagen/configuración sin imprimir secretos\n'
cp "$DEPLOY_RECEIPT" "$TEMP/first.receipt"

updates="$(jq -r .updates "$MOCK_STATE")"
jq '.revision.properties.runningState="Running" | .revision.properties.healthState="Healthy" | .revision.properties.replicas=1 | .revision.properties.provisioningState="Provisioned"' "$MOCK_STATE" > "$TEMP/state.tmp"
mv "$TEMP/state.tmp" "$MOCK_STATE"
bash "$DEPLOY" api-gateway "$TARGET" > "$TEMP/idempotent.log" 2>&1 || { cat "$TEMP/idempotent.log"; fail 'idempotencia tras inactividad'; }
[[ "$(jq -r .updates "$MOCK_STATE")" == "$updates" ]] || fail 'idempotencia creó una revisión'
grep -Fq Idempotencia "$TEMP/idempotent.log" || fail 'idempotencia no registrada'
grep -Fq 'Idempotencia' "$TEMP/idempotent.log" || fail 'idempotencia no fue registrada'
printf 'PASS: idempotencia con el mismo digest conserva revisión y tráfico\n'

previous_from_receipt="$(jq -r '.previous' "$TEMP/first.receipt")"
target_from_receipt="$(jq -r '.target' "$TEMP/first.receipt")"
config_from_receipt="$(jq -r '.config_sha256' "$TEMP/first.receipt")"
[[ "$previous_from_receipt" == "$PREVIOUS" && "$target_from_receipt" == "$TARGET" && "$config_from_receipt" =~ ^[0-9a-f]{64}$ ]] || fail 'recibo no conserva digests/configuración necesarios'
jq -e '.destination=="chile-shared" and .github_environment=="azure-h5-chile" and .workflow_run_id=="12345" and .resource_group=="rg-g6-aca-chile" and .aca_environment=="env-g6-phase1-chile" and .location=="Chile Central" and .subscription_id=="fef42188-accd-4470-ae88-78f583eb4906" and (.app_resource_id|contains("/containerApps/api-gateway")) and .container=="api-gateway" and .origin_https=="https://api-gateway.internal.chilecentral.azurecontainerapps.io" and .digest_candidate==.served_digest and .served_revision=="rev-1" and .traffic_weight==100' "$TEMP/first.receipt" >/dev/null || { cat "$TEMP/first.receipt"; fail 'recibo no queda vinculado a destino, recurso, FQDN y tráfico Chile'; }
for traffic in old ambiguous; do
  if MOCK_TRAFFIC="$traffic" bash "$DEPLOY" api-gateway "$TARGET" >/dev/null 2>&1; then fail "Chile accepted traffic mode $traffic"; fi
done
echo 'PASS: receipt confirms effective traffic revision/digest; old or ambiguous traffic is rejected without weight rewriting'
jq '.properties.configuration.ingress.targetPort=3001' "$MOCK_STATE" > "$TEMP/state.tmp"
mv "$TEMP/state.tmp" "$MOCK_STATE"
if bash "$DEPLOY" --restore api-gateway "$PREVIOUS" "$TARGET" "$config_from_receipt" > "$TEMP/concurrent.log" 2>&1; then fail 'recuperación sobrescribió cambio concurrente de ingress'; fi
grep -Fq 'RECUPERACIÓN OMITIDA' "$TEMP/concurrent.log" || fail 'cambio concurrente no diagnosticado'
jq '.properties.configuration.ingress.targetPort=3000' "$MOCK_STATE" > "$TEMP/state.tmp"
mv "$TEMP/state.tmp" "$MOCK_STATE"
AZURE_CHILE_DEPLOY_ENABLED=false bash "$DEPLOY" --restore api-gateway "$PREVIOUS" "$TARGET" "$config_from_receipt" > "$TEMP/restore.log" 2>&1 || { cat "$TEMP/restore.log"; fail 'recuperación coordinada con ventana cerrada'; }
grep -Fq 'ROLLBACK COORDINADO VERIFICADO' "$TEMP/restore.log" || fail 'recuperación no quedó confirmada'
updates_before_present_restore="$(jq -r .updates "$MOCK_STATE")"
[[ "$config_from_receipt" =~ ^[0-9a-f]{64}$ ]] || fail 'recibo no contiene un hash normalizado válido para la prueba de recuperación'
jq '.properties.configuration.ingress.traffic=[{latestRevision:true,weight:50},{revisionName:"rev-0",weight:50}]' "$MOCK_STATE" > "$TEMP/state.tmp"
mv "$TEMP/state.tmp" "$MOCK_STATE"
if AZURE_CHILE_DEPLOY_ENABLED=false bash "$DEPLOY" --restore api-gateway "$PREVIOUS" "$TARGET" "$config_from_receipt" > "$TEMP/restore-present-wrong-traffic.log" 2>&1; then fail 'recuperación ya presente aceptó tráfico ambiguo con hash válido'; fi
grep -Fq 'RECUPERACIÓN NO VERIFICADA: Gateway' "$TEMP/restore-present-wrong-traffic.log" || { cat "$TEMP/restore-present-wrong-traffic.log"; fail 'recuperación ya presente sin tráfico efectivo no fue bloqueada'; }
[[ "$(jq -r .updates "$MOCK_STATE")" == "$updates_before_present_restore" ]] || fail 'recuperación ya presente intentó cambiar el tráfico'
jq '.properties.configuration.ingress.traffic=[{revisionName:.properties.latestRevisionName,weight:100}]' "$MOCK_STATE" > "$TEMP/state.tmp"
mv "$TEMP/state.tmp" "$MOCK_STATE"
updates_before_present_restore="$(jq -r .updates "$MOCK_STATE")"
AZURE_CHILE_DEPLOY_ENABLED=false bash "$DEPLOY" --restore api-gateway "$PREVIOUS" "$TARGET" "$config_from_receipt" > "$TEMP/restore-present-valid.log" 2>&1 || { cat "$TEMP/restore-present-valid.log"; fail 'recuperación presente con tráfico saludable no fue aceptada'; }
grep -Fq 'RECUPERACIÓN YA PRESENTE' "$TEMP/restore-present-valid.log" || fail 'recuperación presente saludable no quedó identificada'
[[ "$(jq -r .updates "$MOCK_STATE")" == "$updates_before_present_restore" ]] || fail 'recuperación ya presente creó una revisión'
DEPLOY_RECEIPT="$TEMP/redeploy.receipt" bash "$DEPLOY" api-gateway "$TARGET" >/dev/null 2>&1 || fail 'reaplicación de fixture'
jq --arg previous "$PREVIOUS" '.properties.template.containers |= map(if .name == "api-gateway" then .image=$previous else . end) | .revision.properties.template.containers |= map(if .name == "api-gateway" then .image=$previous else . end)' "$MOCK_STATE" > "$TEMP/state.tmp"
mv "$TEMP/state.tmp" "$MOCK_STATE"
if MOCK_SCALE_ZERO=true DEPLOY_RECEIPT="$TEMP/scale-zero.receipt" bash "$DEPLOY" api-gateway "$TARGET" > "$TEMP/scale-zero.log" 2>&1; then fail 'Chile aceptó revisión Gateway escalada a cero'; fi
grep -Fq 'verificación latest/ready/health/running' "$TEMP/scale-zero.log" || fail 'scale-to-zero no se reportó como fallo de readiness'
printf 'PASS: Gateway Chile no acepta revisión escalada a cero\n'
printf 'PASS: recibo digest-only permite recuperar y omite cambios concurrentes de ingress\n'

jq --arg previous "$PREVIOUS" '.properties.template.containers |= map(if .name == "api-gateway" then .image=$previous else . end) | .properties.latestRevisionName="rev-restore" | .properties.latestReadyRevisionName="rev-restore" | .revision.properties.template.containers |= map(if .name == "api-gateway" then .image=$previous else . end) | .revision.properties.healthState="Healthy" | .revision.properties.runningState="Running" | .revision.properties.replicas=1 | .revision.properties.provisioningState="Provisioned"' "$MOCK_STATE" > "$TEMP/state.tmp"
mv "$TEMP/state.tmp" "$MOCK_STATE"
 jq '.updates=0' "$MOCK_STATE" > "$TEMP/state.tmp"
mv "$TEMP/state.tmp" "$MOCK_STATE"
if bash "$DEPLOY" api-gateway "$TARGET" > "$TEMP/predeploy-wrong-traffic.log" 2>&1; then :; else cat "$TEMP/predeploy-wrong-traffic.log"; fail 'healthy Gateway did not transition from pinned old revision'; fi
grep -Fq 'Despliegue verificado' "$TEMP/predeploy-wrong-traffic.log" || fail 'Gateway traffic transition not verified'
jq --arg previous "$PREVIOUS" '.properties.template.containers |= map(if .name == "api-gateway" then .image=$previous else . end) | .properties.latestRevisionName="rev-restore" | .properties.latestReadyRevisionName="rev-restore" | .properties.configuration.ingress.traffic=[{revisionName:"rev-restore",weight:100}] | .revision.properties.template.containers |= map(if .name == "api-gateway" then .image=$previous else . end) | .revision.properties.healthState="Healthy" | .revision.properties.runningState="Running" | .revision.properties.replicas=1 | .revision.properties.provisioningState="Provisioned" | .updates=0' "$MOCK_STATE" > "$TEMP/state.tmp"
mv "$TEMP/state.tmp" "$MOCK_STATE"
export MOCK_UNHEALTHY_TARGET="$TARGET"
if bash "$DEPLOY" api-gateway "$TARGET" > "$TEMP/rollback.log" 2>&1; then fail 'despliegue unhealthy aceptado'; fi
grep -Fq 'TRÁFICO PREVIO CONSERVADO' "$TEMP/rollback.log" || { cat "$TEMP/rollback.log"; fail 'tráfico anterior no se conservó ante revisión unhealthy'; }
jq -e '.properties.configuration.ingress.traffic[0].revisionName == "rev-restore" and .properties.configuration.ingress.traffic[0].weight == 100' "$MOCK_STATE" >/dev/null || fail 'revisión unhealthy recibió tráfico'
[[ "$(jq -r '[.properties.template.containers[] | select(.name == "api-gateway")][0].image' "$MOCK_STATE")" == "$PREVIOUS" ]] || fail 'recuperación no restauró el digest anterior en la plantilla'
printf 'PASS: revisión unhealthy no recibe tráfico y la plantilla vuelve al digest anterior\n'
unset MOCK_UNHEALTHY_TARGET
if bash "$DEPLOY" api-gateway "$TARGET" > "$TEMP/retry-after-recovery.log" 2>&1; then :; else cat "$TEMP/retry-after-recovery.log"; fail 'nuevo despliegue falló tras recuperación de plantilla'; fi
grep -Fq 'Despliegue verificado' "$TEMP/retry-after-recovery.log" || fail 'nuevo despliegue no quedó verificado tras recuperación'
jq -e --arg target "$TARGET" '.properties.template.containers[] | select(.name == "api-gateway") | .image == $target' "$MOCK_STATE" >/dev/null || fail 'nuevo despliegue no aplicó digest candidato'
printf 'PASS: nuevo despliegue oficial vuelve a ser ejecutable tras recuperar plantilla\n'
[[ -f "$MOCK_STATE" ]] || fail 'mock state missing'
jq --arg previous "$PREVIOUS" '.properties.template.containers |= map(if .name == "api-gateway" then .image=$previous else . end) | .properties.configuration.ingress.traffic=[{revisionName:"rev-restore",weight:100}] | .properties.latestRevisionName="rev-restore" | .properties.latestReadyRevisionName="rev-restore" | .revision.properties.template.containers |= map(if .name == "api-gateway" then .image=$previous else . end) | .revision.properties.healthState="Healthy" | .revision.properties.runningState="Running" | .revision.properties.replicas=1 | .revision.properties.provisioningState="Provisioned" | .updates=0 | .trafficSetCount=0' "$MOCK_STATE" > "$TEMP/state.tmp"
mv "$TEMP/state.tmp" "$MOCK_STATE"
if MOCK_TRAFFIC_SET_FAIL_ON=2 bash "$DEPLOY" api-gateway "$TARGET" > "$TEMP/cutover-fail.log" 2>&1; then fail 'corte de tráfico fallido declarado exitoso'; fi
grep -Fq 'TRÁFICO PREVIO CONSERVADO' "$TEMP/cutover-fail.log" || { cat "$TEMP/cutover-fail.log"; fail 'fallo de corte no conservó la ruta previa'; }
jq -e '.properties.configuration.ingress.traffic[0].revisionName == "rev-restore" and .properties.configuration.ingress.traffic[0].weight == 100' "$MOCK_STATE" >/dev/null || fail 'fallo de corte dejó Gateway en ruta inesperada'
printf 'PASS: fallo de corte conserva ruta anterior y candidata para recuperación\n'
updates_before_concurrent="$(jq -r .updates "$MOCK_STATE")"
jq --arg previous "$PREVIOUS" '.properties.template.containers |= map(if .name == "api-gateway" then .image=$previous else . end) | .properties.configuration.ingress.traffic=[{revisionName:"rev-restore",weight:100}] | .properties.latestRevisionName="rev-restore" | .properties.latestReadyRevisionName="rev-restore" | .revision.properties.template.containers |= map(if .name == "api-gateway" then .image=$previous else . end) | .revision.properties.healthState="Healthy" | .revision.properties.runningState="Running" | .revision.properties.replicas=1 | .revision.properties.provisioningState="Provisioned"' "$MOCK_STATE" > "$TEMP/state.tmp"
mv "$TEMP/state.tmp" "$MOCK_STATE"
if MOCK_CONCURRENT_TRAFFIC=rev-concurrent bash "$DEPLOY" api-gateway "$TARGET" > "$TEMP/concurrent-traffic.log" 2>&1; then fail 'tráfico concurrente fue sobrescrito'; fi
grep -Fq 'RECUPERACIÓN OMITIDA' "$TEMP/concurrent-traffic.log" || { cat "$TEMP/concurrent-traffic.log"; fail 'cambio concurrente de tráfico no fue detectado'; }
jq -e '.properties.configuration.ingress.traffic[0].revisionName == "rev-concurrent"' "$MOCK_STATE" >/dev/null || fail 'se sobrescribió tráfico concurrente'
[[ "$(jq -r .updates "$MOCK_STATE")" == $((updates_before_concurrent + 1)) ]] || fail 'fixture concurrente no creó revisión'
printf 'PASS: Gateway aborta sin sobrescribir tráfico concurrente\n'
updates_before_zero="$(jq -r .updates "$MOCK_STATE")"
jq '.properties.template.scale.minReplicas=0' "$MOCK_STATE" > "$TEMP/state.tmp"
mv "$TEMP/state.tmp" "$MOCK_STATE"
if bash "$DEPLOY" api-gateway "$TARGET" > "$TEMP/min-zero.log" 2>&1; then fail 'Gateway Chile aceptó minReplicas=0'; fi
grep -Fq 'minReplicas=1 y maxReplicas=1' "$TEMP/min-zero.log" || fail 'Gateway minReplicas=0 no produjo un error explícito'
[[ "$(jq -r .updates "$MOCK_STATE")" == "$updates_before_zero" ]] || fail 'precondición de escala cero modificó la ACA'
printf 'PASS: Gateway Chile minReplicas=0 falla antes de mutar Azure\n'

jq --arg previous "$PROMO_PREVIOUS" '.properties.configuration.activeRevisionsMode="Single" | .properties.configuration.ingress.external=false | .properties.configuration.ingress.traffic=[{latestRevision:true,weight:100}] | .properties.template.containers |= map(if .name == "api-gateway" then .name="promotions-svc" | .image=$previous else . end) | .properties.template.scale.minReplicas=1 | .properties.template.scale.maxReplicas=1 | .properties.latestRevisionName="promo-0" | .properties.latestReadyRevisionName="promo-0" | .revision.properties.template.containers |= map(if .name == "api-gateway" then .name="promotions-svc" | .image=$previous else . end) | .revision.properties.template.scale.minReplicas=1 | .revision.properties.template.scale.maxReplicas=1 | .revision.properties.healthState="Healthy" | .revision.properties.runningState="Running" | .revision.properties.replicas=1 | .revision.properties.provisioningState="Provisioned" | .updates=0' "$MOCK_STATE" > "$TEMP/promotions-state.json"
MOCK_SERVICE=promotions-svc MOCK_STATE="$TEMP/promotions-state.json" bash "$DEPLOY" promotions-svc "$PROMO_TARGET" > "$TEMP/promotions.log" 2>&1 || { cat "$TEMP/promotions.log"; fail 'Promotions Single deploy failed'; }
grep -Fq 'Despliegue verificado' "$TEMP/promotions.log" || fail 'Promotions Single not verified'
jq -e '.properties.configuration.activeRevisionsMode == "Single" and .properties.configuration.ingress.traffic[0].latestRevision == true and .properties.template.scale.minReplicas == 1 and .properties.template.scale.maxReplicas == 1' "$TEMP/promotions-state.json" >/dev/null || fail 'Promotions Single configuration changed'
MOCK_SERVICE=promotions-svc MOCK_STATE="$TEMP/promotions-state.json" bash -c 'jq ".properties.template.scale.minReplicas=0" "$MOCK_STATE" > "$MOCK_STATE.tmp" && mv "$MOCK_STATE.tmp" "$MOCK_STATE"'
promo_updates="$(jq -r .updates "$TEMP/promotions-state.json")"
if MOCK_SERVICE=promotions-svc MOCK_STATE="$TEMP/promotions-state.json" bash "$DEPLOY" promotions-svc "$PROMO_TARGET" > "$TEMP/promotions-min-zero.log" 2>&1; then fail 'Promotions Chile accepted minReplicas=0'; fi
grep -Fq 'minReplicas=1 y maxReplicas=1' "$TEMP/promotions-min-zero.log" || fail 'Promotions minReplicas=0 not explicitly rejected'
[[ "$(jq -r .updates "$TEMP/promotions-state.json")" == "$promo_updates" ]] || fail 'Promotions scale precondition mutated ACA'
printf 'PASS: Promotions conserva Single y rechaza minReplicas=0 antes de mutar Azure\n'

cp "$MOCK_STATE" "$TEMP/brazil-state.json"
MOCK_STATE="$TEMP/brazil-state.json" MOCK_RESOURCE_GROUP=rg-g6-sb-h5-int-fork MOCK_SCALE_ZERO=true H5_DEPLOY_ENVIRONMENT=azure-h5 H5_DEPLOY_DESTINATION=brazil-isolated H5_PILOT_SELF_REVIEW=false bash "$DEPLOY" api-gateway "$BRAZIL_TARGET" > "$TEMP/brazil.log" 2>&1 || { cat "$TEMP/brazil.log"; fail 'Brazil behavior changed by Chile hot-replica rule'; }
grep -Fq 'modo=scale-to-zero réplicas=0' "$TEMP/brazil.log" || fail 'Brazil scale-to-zero verification behavior changed'
printf 'PASS: Brasil conserva la verificación previa de escala cero\n'

# Regresión run 45868007664: catalog-svc en Chile con runningState=RunningAtMaxScale y runningStatus dinámico
cat > "$TEMP/catalog-maxscale.json" <<EOF
{"properties":{"runningStatus":"Running","configuration":{"activeRevisionsMode":"Single","secrets":[{"name":"ACA_PRIVATE_SENTINEL","value":"must-not-be-printed"}],"ingress":{"external":false,"targetPort":3001,"traffic":[{"latestRevision":true,"weight":100}]}},"template":{"revisionSuffix":"b80jpbt","containers":[{"name":"catalog-svc","image":"ghcr.io/taller-sw-web/g6-productos-ofertas-backend/catalog-svc@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","env":[{"name":"PRIVATE_SETTING","value":"must-not-be-printed"}]}],"scale":{"minReplicas":1,"maxReplicas":1}},"latestRevisionName":"catalog-svc--b80jpbt","latestReadyRevisionName":"catalog-svc--b80jpbt"},"revision":{"properties":{"healthState":"Healthy","active":true,"runningState":"RunningAtMaxScale","replicas":1,"provisioningState":"Provisioned","template":{"containers":[{"name":"catalog-svc","image":"ghcr.io/taller-sw-web/g6-productos-ofertas-backend/catalog-svc@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","env":[{"name":"PRIVATE_SETTING","value":"must-not-be-printed"}]}],"scale":{"minReplicas":1,"maxReplicas":1}}}},"updates":0,"trafficSetCount":0}
EOF
cat > "$TEMP/bin/az-maxscale" <<'MOCK2'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${1:-}" == containerapp && "${2:-}" == update ]]; then
  "$MOCK_BASE_AZ" "$@"
  jq '.revision.properties.runningState="RunningAtMaxScale" | .properties.runningStatus="Progressing"' "$MOCK_STATE" > "$MOCK_STATE.tmp"
  mv "$MOCK_STATE.tmp" "$MOCK_STATE"
  exit 0
fi
exec "$MOCK_BASE_AZ" "$@"
MOCK2
chmod +x "$TEMP/bin/az-maxscale"
CAT_TARGET='ghcr.io/taller-sw-web/g6-productos-ofertas-backend/catalog-svc@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
MOCK_BASE_AZ="$TEMP/bin/az" PATH="$TEMP/bin:$PATH" bash -c '
  ln -sf "$MOCK_BASE_AZ-maxscale" "'"$TEMP"'/bin/az-wrap"
' >/dev/null 2>&1 || true
MOCK_SERVICE=catalog-svc MOCK_STATE="$TEMP/catalog-maxscale.json" H5_DEPLOY_ENVIRONMENT=azure-h5-chile H5_DEPLOY_DESTINATION=chile-shared H5_PILOT_SELF_REVIEW=false bash -c '
  mkdir -p "'"$TEMP"'/wrapbin"
  ln -sf "'"$TEMP"'/bin/az-maxscale" "'"$TEMP"'/wrapbin/az"
  export MOCK_BASE_AZ="'"$TEMP"'/bin/az"
  export PATH="'"$TEMP"'/wrapbin:$PATH"
  bash "'"$DEPLOY"'" catalog-svc "'"$CAT_TARGET"'"
' > "$TEMP/catalog-maxscale.log" 2>&1 || { cat "$TEMP/catalog-maxscale.log"; fail 'RunningAtMaxScale con Healthy y Provisioned debe aceptarse sin falso drift'; }
grep -Fq 'Despliegue verificado: servicio=catalog-svc' "$TEMP/catalog-maxscale.log" || fail 'RunningAtMaxScale no quedó verificado'
printf 'PASS: RunningAtMaxScale saludable y cambio dinámico de runningStatus aceptados sin falso drift\n'

# Rechazo de estados degradados/no preparados incluso con RunningAtMaxScale o Stopped/ScaledToZero/Failed
for bad_state in "RunningAtMaxScale:Unhealthy:1:Provisioned" "RunningAtMaxScale:Healthy:0:Provisioned" "RunningAtMaxScale:Healthy:1:Failed" "Failed:Healthy:1:Provisioned" "Stopped:Healthy:1:Provisioned" "ScaledToZero:Healthy:1:Provisioned"; do
  IFS=: read -r r_state r_health r_reps r_prov <<< "$bad_state"
  cp "$TEMP/catalog-maxscale.json" "$TEMP/bad-state.json"
  jq --arg rs "$r_state" --arg rh "$r_health" --argjson rr "$r_reps" --arg rp "$r_prov" \
    '.revision.properties.runningState=$rs | .revision.properties.healthState=$rh | .revision.properties.replicas=$rr | .revision.properties.provisioningState=$rp' \
    "$TEMP/bad-state.json" > "$TEMP/bad-state.tmp" && mv "$TEMP/bad-state.tmp" "$TEMP/bad-state.json"
  if MOCK_SERVICE=catalog-svc MOCK_STATE="$TEMP/bad-state.json" H5_DEPLOY_ENVIRONMENT=azure-h5-chile H5_DEPLOY_DESTINATION=chile-shared H5_PILOT_SELF_REVIEW=false \
    bash "$DEPLOY" catalog-svc "$CAT_TARGET" > "$TEMP/bad-state.log" 2>&1; then
    fail "Estado inválido $bad_state fue aceptado"
  fi
done
printf 'PASS: estados degradados, Failed, Stopped y ScaledToZero con réplicas/salud inválidas siguen rechazándose\n'
