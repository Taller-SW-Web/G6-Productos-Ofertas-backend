#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
readonly ROOT
readonly DEPLOY="$ROOT/ops/azure/container-apps/deploy.sh"
TEMP="$(mktemp -d)"
readonly TEMP
readonly PREVIOUS='ghcr.io/taller-sw-web/g6-productos-ofertas-backend/api-gateway@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
readonly TARGET='ghcr.io/taller-sw-web/g6-productos-ofertas-backend/api-gateway@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
trap 'rm -rf "$TEMP"' EXIT
mkdir "$TEMP/bin"
cat > "$TEMP/state.json" <<EOF
{"properties":{"configuration":{"activeRevisionsMode":"Multiple","secrets":[{"name":"ACA_PRIVATE_SENTINEL","value":"must-not-be-printed"}],"ingress":{"external":true,"targetPort":3000}},"template":{"revisionSuffix":"initial","containers":[{"name":"api-gateway","image":"$PREVIOUS","env":[{"name":"PRIVATE_SETTING","value":"must-not-be-printed"}]},{"name":"caddy","image":"ghcr.io/taller-sw-web/caddy@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}],"scale":{"minReplicas":0,"maxReplicas":1}},"latestRevisionName":"rev-0","latestReadyRevisionName":"rev-0"},"revision":{"properties":{"healthState":"Healthy","active":true,"runningState":"Running","template":{"containers":[{"name":"api-gateway","image":"$PREVIOUS","env":[{"name":"PRIVATE_SETTING","value":"must-not-be-printed"}]},{"name":"caddy","image":"ghcr.io/taller-sw-web/caddy@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}],"scale":{"minReplicas":0,"maxReplicas":1}}}},"updates":0}
EOF
cat > "$TEMP/bin/az" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
state="${MOCK_STATE:?}"
subscription='fef42188-accd-4470-ae88-78f583eb4906'
[[ "${MOCK_BAD_SUBSCRIPTION:-false}" != true ]] || subscription='00000000-0000-0000-0000-000000000000'
group="${MOCK_RESOURCE_GROUP:-rg-g6-aca-chile}"
aca_env='env-g6-phase1-chile'
location='chilecentral'
if [[ "$group" == rg-g6-sb-h5-int-fork ]]; then aca_env='env-g6-h5-int'; location='brazilsouth'; fi
env_id="/subscriptions/$subscription/resourceGroups/$group/providers/Microsoft.App/managedEnvironments/$aca_env"
app_id="/subscriptions/$subscription/resourceGroups/$group/providers/Microsoft.App/containerApps/api-gateway"
if [[ "${1:-}" == account && "${2:-}" == show ]]; then printf '%s\n' "$subscription"; exit 0; fi
if [[ "${1:-}" == containerapp ]]; then [[ "$*" == *"--resource-group ${MOCK_RESOURCE_GROUP:-rg-g6-aca-chile}"* ]] || { echo 'wrong resource group' >&2; exit 61; }; fi
if [[ "${1:-}" == group && "${2:-}" == show ]]; then printf '{"id":"/subscriptions/%s/resourceGroups/%s"}\n' "$subscription" "$group"; exit 0; fi
if [[ "${1:-}" == containerapp && "${2:-}" == env && "${3:-}" == show ]]; then [[ "${MOCK_BAD_ENVIRONMENT:-false}" != true ]] || env_id="$env_id-wrong"; printf '{"id":"%s","location":"%s"}\n' "$env_id" "$location"; exit 0; fi
if [[ "${1:-}" == containerapp && "${2:-}" == show ]]; then
  jq --arg id "$app_id" --arg env "$env_id" --arg traffic "${MOCK_TRAFFIC:-latest}" '. + {id:$id} | .properties.managedEnvironmentId=$env | .properties.configuration.ingress.fqdn="api-gateway.internal.chilecentral.azurecontainerapps.io" | .properties.configuration.ingress.allowInsecure=false | .properties.configuration.ingress.traffic=(if $traffic == "old" then [{revisionName:"rev-0",weight:100}] elif $traffic == "ambiguous" then [{latestRevision:true,weight:50},{revisionName:"rev-0",weight:50}] elif $traffic == "old-after-rollback" and .updates >= 2 then [{revisionName:"rev-0",weight:100}] else [{latestRevision:true,weight:100}] end)' "$state"
  exit 0
fi
if [[ "${1:-}" == containerapp && "${2:-}" == revision && "${3:-}" == show ]]; then
  jq -c --arg startup "${MOCK_STARTUP:-false}" '(.revisionPolls += 1) | if $startup == "true" and .revisionPolls == 1 then .revision.properties.runningState="Processing" elif $startup == "true" and .revisionPolls >= 2 then .revision.properties.runningState="Running" else . end | .revision' "$state"
  jq --arg startup "${MOCK_STARTUP:-false}" '(.revisionPolls += 1) | if $startup == "true" and .revisionPolls == 1 then .revision.properties.runningState="Processing" elif $startup == "true" and .revisionPolls >= 2 then .revision.properties.runningState="Running" else . end' "$state" > "$state.tmp"
  mv "$state.tmp" "$state"
  exit 0
fi
if [[ "${1:-}" == containerapp && "${2:-}" == update ]]; then
  [[ "$*" == *'--container-name api-gateway'* ]] || { echo 'container name missing' >&2; exit 62; }
  image=''
  while (($#)); do [[ "$1" != --image ]] || { shift; image="$1"; }; shift || true; done
  [[ -n "$image" ]] || exit 63
  jq --arg image "$image" --arg unhealthy_target "${MOCK_UNHEALTHY_TARGET:-}" --arg unhealthy_rollback "${MOCK_UNHEALTHY_ROLLBACK:-false}" --arg scale_zero "${MOCK_SCALE_ZERO:-false}" '
    .updates += 1 |
    .properties.template.containers |= map(if .name == "api-gateway" then .image=$image else . end) |
    .properties.latestRevisionName = ("rev-" + (.updates|tostring)) |
    .properties.latestReadyRevisionName = .properties.latestRevisionName |
    .properties.template.revisionSuffix = ("revision-" + (.updates|tostring)) |
    .revision.properties.template = .properties.template |
    .revisionPolls = 0 |
    .revision.properties.replicas = (if $scale_zero == "true" then 0 else 1 end) |
    .revision.properties.provisioningState = "Provisioned" |
    .revision.properties.healthState = (if $image == $unhealthy_target or ($unhealthy_rollback == "true" and ($image | contains("@sha256:aaaaaaaa"))) then "Unhealthy" elif $scale_zero == "true" then "None" else "Healthy" end) |
    .revision.properties.runningState = (if $image == $unhealthy_target or ($unhealthy_rollback == "true" and ($image | contains("@sha256:aaaaaaaa"))) then "Failed" elif $scale_zero == "true" then "ScaledToZero" else "Running" end)
  ' "$state" > "$state.tmp"
  mv "$state.tmp" "$state"
  exit 0
fi
exit 64
MOCK
chmod +x "$TEMP/bin/az"
export PATH="$TEMP/bin:$PATH" MOCK_STATE="$TEMP/state.json" ACA_POLL_ATTEMPTS=2 ACA_POLL_INTERVAL_SECONDS=0
export DEPLOY_RECEIPT="$TEMP/gateway.receipt"
export GITHUB_RUN_ID=12345
export MOCK_STARTUP=true
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
unset MOCK_STARTUP

updates="$(jq -r .updates "$MOCK_STATE")"
jq '.revision.properties.runningState="Stopped" | .revision.properties.healthState="None" | .revision.properties.replicas=0 | .revision.properties.provisioningState="Provisioned"' "$MOCK_STATE" > "$TEMP/state.tmp"
mv "$TEMP/state.tmp" "$MOCK_STATE"
bash "$DEPLOY" api-gateway "$TARGET" > "$TEMP/idempotent.log" 2>&1 || { cat "$TEMP/idempotent.log"; fail 'idempotencia tras inactividad'; }
[[ "$(jq -r .updates "$MOCK_STATE")" == "$updates" ]] || fail 'idempotencia creó una revisión'
grep -Fq Idempotencia "$TEMP/idempotent.log" || fail 'idempotencia no registrada'
grep -Fq 'modo=scale-to-zero réplicas=0 salud=None' "$TEMP/idempotent.log" || fail 'estado Scale to 0 no fue distinguido'
printf 'PASS: idempotencia tras inactividad acepta Stopped/0 sin crear revisión\n'

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
wrong_traffic_config="$(MOCK_TRAFFIC=old az containerapp show --subscription fef42188-accd-4470-ae88-78f583eb4906 --name api-gateway --resource-group rg-g6-aca-chile --output json | jq -S -c --arg target api-gateway '{identity:.identity,location:.location,tags:.tags,kind:.kind,properties:(.properties|del(.latestRevisionName,.latestReadyRevisionName,.latestRevisionFqdn,.provisioningState,.configuration.ingress.traffic)|.template|= (del(.revisionSuffix)|.containers|=map(if .name==$target then del(.image) else . end)))}')"
wrong_traffic_hash="$(printf '%s' "$wrong_traffic_config" | sha256sum | awk '{print $1}')"
if MOCK_TRAFFIC=old AZURE_CHILE_DEPLOY_ENABLED=false bash "$DEPLOY" --restore api-gateway "$PREVIOUS" "$TARGET" "$wrong_traffic_hash" > "$TEMP/restore-present-wrong-traffic.log" 2>&1; then fail 'recuperación ya presente aceptó una revisión saludable con tráfico en otra revisión'; fi
grep -Fq 'RECUPERACIÓN NO VERIFICADA' "$TEMP/restore-present-wrong-traffic.log" || { cat "$TEMP/restore-present-wrong-traffic.log"; fail 'recuperación ya presente sin tráfico efectivo no fue bloqueada'; }
[[ "$(jq -r .updates "$MOCK_STATE")" == "$updates_before_present_restore" ]] || fail 'recuperación ya presente intentó cambiar el tráfico'
DEPLOY_RECEIPT="$TEMP/redeploy.receipt" bash "$DEPLOY" api-gateway "$TARGET" >/dev/null 2>&1 || fail 'reaplicación de fixture'
jq --arg previous "$PREVIOUS" '.properties.template.containers |= map(if .name == "api-gateway" then .image=$previous else . end) | .revision.properties.template.containers |= map(if .name == "api-gateway" then .image=$previous else . end)' "$MOCK_STATE" > "$TEMP/state.tmp"
mv "$TEMP/state.tmp" "$MOCK_STATE"
MOCK_SCALE_ZERO=true DEPLOY_RECEIPT="$TEMP/scale-zero.receipt" bash "$DEPLOY" api-gateway "$TARGET" > "$TEMP/scale-zero.log" 2>&1 || { cat "$TEMP/scale-zero.log"; fail 'actualización válida con escala cero'; }
grep -Fq 'modo=scale-to-zero réplicas=0 salud=None' "$TEMP/scale-zero.log" || fail 'revisión nueva escalada a cero no aceptada'
printf 'PASS: revisión nueva valida Scale to 0 sin afirmar liveness/readiness\n'
printf 'PASS: recibo digest-only permite recuperar y omite cambios concurrentes de ingress\n'

jq --arg previous "$PREVIOUS" '.properties.template.containers |= map(if .name == "api-gateway" then .image=$previous else . end) | .properties.latestRevisionName="rev-restore" | .properties.latestReadyRevisionName="rev-restore" | .revision.properties.template.containers |= map(if .name == "api-gateway" then .image=$previous else . end) | .revision.properties.healthState="Healthy"' "$MOCK_STATE" > "$TEMP/state.tmp"
mv "$TEMP/state.tmp" "$MOCK_STATE"
 jq '.updates=0' "$MOCK_STATE" > "$TEMP/state.tmp"
mv "$TEMP/state.tmp" "$MOCK_STATE"
if MOCK_TRAFFIC=old bash "$DEPLOY" api-gateway "$TARGET" > "$TEMP/predeploy-wrong-traffic.log" 2>&1; then fail 'Chile deployment accepted traffic pinned to another revision'; fi
grep -Fq 'tráfico Chile previo es ambiguo/incompatible' "$TEMP/predeploy-wrong-traffic.log" || fail 'pre-deploy incompatible traffic was not blocked'
[[ "$(jq -r .updates "$MOCK_STATE")" == 0 ]] || fail 'incompatible pre-deploy traffic modified ACA'
export MOCK_UNHEALTHY_TARGET="$TARGET"
if bash "$DEPLOY" api-gateway "$TARGET" > "$TEMP/rollback.log" 2>&1; then fail 'despliegue unhealthy aceptado'; fi
grep -Fq 'ROLLBACK VERIFICADO' "$TEMP/rollback.log" || { cat "$TEMP/rollback.log"; fail 'rollback no se verificó'; }
jq -e --arg previous "$PREVIOUS" '.properties.template.containers[] | select(.name == "api-gateway") | .image == $previous' "$MOCK_STATE" >/dev/null || fail 'rollback no restauró imagen previa'
printf 'PASS: fallo de revisión restaura y verifica digest anterior y configuración\n'

jq --arg previous "$PREVIOUS" '.properties.template.containers |= map(if .name == "api-gateway" then .image=$previous else . end) | .properties.latestRevisionName="rev-restore" | .properties.latestReadyRevisionName="rev-restore" | .revision.properties.template.containers |= map(if .name == "api-gateway" then .image=$previous else . end) | .revision.properties.healthState="Healthy"' "$MOCK_STATE" > "$TEMP/state.tmp"
mv "$TEMP/state.tmp" "$MOCK_STATE"
export MOCK_UNHEALTHY_ROLLBACK=true
if bash "$DEPLOY" api-gateway "$TARGET" > "$TEMP/rollback-fail.log" 2>&1; then fail 'rollback unhealthy aceptado'; fi
grep -Fq 'ROLLBACK NO VERIFICADO' "$TEMP/rollback-fail.log" || fail 'fallo de rollback no reportado'
printf 'PASS: nunca declara rollback si la verificación de recuperación falla\n'

unset MOCK_UNHEALTHY_ROLLBACK
jq --arg previous "$PREVIOUS" '.properties.template.containers |= map(if .name == "api-gateway" then .image=$previous else . end) | .properties.latestRevisionName="rev-restore" | .properties.latestReadyRevisionName="rev-restore" | .revision.properties.template.containers |= map(if .name == "api-gateway" then .image=$previous else . end) | .revision.properties.healthState="Healthy" | .updates=0' "$MOCK_STATE" > "$TEMP/state.tmp"
mv "$TEMP/state.tmp" "$MOCK_STATE"
if MOCK_TRAFFIC=old-after-rollback bash "$DEPLOY" api-gateway "$TARGET" > "$TEMP/rollback-wrong-traffic.log" 2>&1; then fail 'local rollback declared successful with traffic on another revision'; fi
grep -Fq 'ROLLBACK NO VERIFICADO' "$TEMP/rollback-wrong-traffic.log" || { cat "$TEMP/rollback-wrong-traffic.log"; fail 'local rollback with wrong traffic was not rejected'; }
if grep -Fq 'ROLLBACK VERIFICADO:' "$TEMP/rollback-wrong-traffic.log"; then fail 'local rollback incorrectly declared traffic recovery successful'; fi
echo 'PASS: healthy previous revision is not reported recovered unless it serves 100% of Chile traffic'
