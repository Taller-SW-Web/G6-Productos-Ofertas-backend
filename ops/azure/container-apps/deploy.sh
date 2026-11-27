#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly REPOSITORY='ghcr.io/taller-sw-web/g6-productos-ofertas-backend'
fail() { printf 'Despliegue Azure fallido: %s\n' "$1" >&2; exit 1; }

TARGETS="$(dirname "$0")/deployment-targets.json"
destination="${H5_DEPLOY_DESTINATION:-brazil-isolated}"
environment="${H5_DEPLOY_ENVIRONMENT:-}"
pilot="${H5_PILOT_SELF_REVIEW:-false}"
gateway_route_profile="${H5_GATEWAY_ROUTE_PROFILE:-standard}"
case "$environment:$destination:$pilot" in
  azure-h5:brazil-isolated:false) target_key=destinations.brazil-isolated ;;
  azure-h5-pilot-234:brazil-isolated:true) target_key=pilot ;;
  azure-h5-chile:chile-shared:false) target_key=destinations.chile-shared ;;
  *) fail 'combinación de destino y GitHub Environment no autorizada' ;;
esac
if [[ "$target_key" == pilot ]]; then
  case "${1:-}" in --restore) service="${2:-}" ;; --inspect) service="${2:-}" ;; *) service="${1:-}" ;; esac
  jq -e --arg service "$service" '.pilot.services | index($service) != null' "$TARGETS" >/dev/null || fail 'el piloto histórico solo admite Pricing y Price Audit'
  resource_group="$(jq -r '.pilot.resourceGroup' "$TARGETS")"
  aca_environment="$(jq -r '.pilot.acaEnvironment' "$TARGETS")"
else
  resource_group="$(jq -r --arg key "$target_key" 'getpath($key | split(".")).resourceGroup' "$TARGETS")"
  aca_environment="$(jq -r --arg key "$target_key" 'getpath($key | split(".")).acaEnvironment' "$TARGETS")"
fi
subscription="$(jq -r '.subscriptionId' "$TARGETS")"
region="$(jq -r --arg key "$target_key" 'getpath($key | split(".")).location' "$TARGETS")"
readonly RESOURCE_GROUP="$resource_group" ACA_ENVIRONMENT="$aca_environment" SUBSCRIPTION="$subscription" REGION="$region" DESTINATION="$destination" DEPLOYMENT_ENVIRONMENT="$environment"

mode=deploy
if [[ "${1:-}" == --restore ]]; then
  [[ $# == 5 ]] || fail 'uso: deploy.sh --restore <servicio> <digest-anterior> <digest-aplicado> <sha256-configuración>'
  mode=restore; service="$2"; previous_image="$3"; image="$4"; expected_config_hash="$5"
elif [[ "${1:-}" == --inspect ]]; then
  [[ $# == 3 ]] || fail 'uso: deploy.sh --inspect <servicio> <imagen-candidata>'
  mode=inspect; service="$2"; image="$3"
else
  [[ $# == 2 ]] || fail 'uso: deploy.sh <servicio> <imagen-con-digest>'
  service="$1"; image="$2"
fi
if [[ "$destination" == chile-shared && "$mode" == deploy && "${AZURE_CHILE_DEPLOY_ENABLED:-}" != true ]]; then
  fail 'AZURE_CHILE_DEPLOY_ENABLED debe ser exactamente true en el Environment azure-h5-chile; no se modifica Azure'
fi
case "$service" in api-gateway|bulk-svc|catalog-svc|combos-svc|inventory-svc|price-audit-svc|pricing-svc|promotions-svc|taxonomy-svc) ;; *) fail 'servicio fuera de la allowlist de nueve aplicaciones' ;; esac
for candidate in "$image" "${previous_image:-$image}"; do
  [[ "$candidate" == "$REPOSITORY/$service@sha256:"* && "${candidate##*@sha256:}" =~ ^[0-9a-f]{64}$ ]] || fail 'imagen fuera del paquete oficial o sin digest inmutable'
done
[[ "$mode" != restore || "$expected_config_hash" =~ ^[0-9a-f]{64}$ ]] || fail 'hash de configuración inválido'
case "$gateway_route_profile" in
  standard) ;;
  g5-labelled)
    [[ "$destination" == chile-shared && "$environment" == azure-h5-chile && "$service" == api-gateway && "$mode" != inspect ]] ||
      fail 'el perfil g5-labelled solo admite deploy/restore de api-gateway en chile-shared con azure-h5-chile'
    ;;
  *) fail 'perfil de Gateway desconocido' ;;
esac

app="$service"; container="$service"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
before="$work/before.json"; after="$work/after.json"; revision="$work/revision.json"
read_app() { az containerapp show --subscription "$SUBSCRIPTION" --name "$app" --resource-group "$RESOURCE_GROUP" --output json; }
validate_target() {
  local account group env app_json expected_env expected_app
  account="$(az account show --subscription "$SUBSCRIPTION" --query id -o tsv)" || fail 'no se pudo validar la suscripción seleccionada'
  [[ "${account,,}" == "${SUBSCRIPTION,,}" ]] || fail 'suscripción Azure distinta de la autorizada'
  group="$(az group show --subscription "$SUBSCRIPTION" --name "$RESOURCE_GROUP" -o json)" || fail 'no se pudo validar el Resource Group'
  [[ "$(jq -r '.id | ascii_downcase' <<< "$group")" == "/subscriptions/${SUBSCRIPTION,,}/resourcegroups/${RESOURCE_GROUP,,}" ]] || fail 'Resource Group ID inesperado'
  env="$(az containerapp env show --subscription "$SUBSCRIPTION" --name "$ACA_ENVIRONMENT" --resource-group "$RESOURCE_GROUP" -o json)" || fail 'Environment ACA inexistente o no legible; no se crean recursos'
  expected_env="/subscriptions/${SUBSCRIPTION,,}/resourcegroups/${RESOURCE_GROUP,,}/providers/microsoft.app/managedenvironments/${ACA_ENVIRONMENT,,}"
  actual_region="$(jq -r '.location | ascii_downcase | gsub("[[:space:]]"; "")' <<< "$env")"
  expected_region="$(printf '%s' "$REGION" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  [[ "$(jq -r '.id | ascii_downcase' <<< "$env")" == "$expected_env" && "$actual_region" == "$expected_region" ]] || fail 'Resource ID o región del Environment ACA no coincide con el destino'
  app_json="$(read_app)" || fail 'ACA solicitada no existe; el CD no crea aplicaciones'
  expected_app="/subscriptions/${SUBSCRIPTION,,}/resourcegroups/${RESOURCE_GROUP,,}/providers/microsoft.app/containerapps/${app,,}"
  [[ "$(jq -r '.id | ascii_downcase' <<< "$app_json")" == "$expected_app" ]] || fail 'Resource ID de ACA inesperado'
  [[ "$(jq -r '.properties.managedEnvironmentId | ascii_downcase' <<< "$app_json")" == "$expected_env" ]] || fail 'ACA pertenece a otro Environment'
}
normalize_app() {
  jq -S -c --arg target "$container" --arg destination "$destination" --arg route_profile "$gateway_route_profile" '
    {
      identity: .identity,
      location: .location,
      tags: .tags,
      kind: .kind,
      properties: (
        .properties
        | del(.latestRevisionName, .latestReadyRevisionName, .latestRevisionFqdn, .provisioningState, .runningStatus)
        | if $destination == "chile-shared" then del(.configuration.ingress.traffic) else . end
        | .template |= (
            del(.revisionSuffix)
            | .containers |= map(
                if .name == $target then
                  del(.image)
                  | if $route_profile == "g5-labelled" then .env = ((.env // []) | map(select(.name != "GATEWAY_G5_H5_ENABLED"))) else . end
                else . end
              )
          )
      )
    }' "$1"
}
container_image() { jq -er --arg name "$container" '[.properties.template.containers[] | select(.name == $name) | .image] | if length == 1 then .[0] else error("container target ausente o duplicado") end' "$1"; }
revision_health() { az containerapp revision show --subscription "$SUBSCRIPTION" --name "$app" --resource-group "$RESOURCE_GROUP" --revision "$1" --output json > "$2"; }
revision_verify_detail='no se obtuvo estado de revisión'
chile_hot_service() { [[ "$destination" == chile-shared && ( "$service" == api-gateway || "$service" == promotions-svc ) ]]; }
verify_chile_scale() {
  local json="$1" min max
  chile_hot_service || return 0
  min="$(jq -r '.properties.template.scale.minReplicas // 0' "$json")"
  max="$(jq -r '.properties.template.scale.maxReplicas // 0' "$json")"
  [[ "$min" == 1 && "$max" == 1 ]] || fail "Chile requiere minReplicas=1 y maxReplicas=1 para $service (actual: min=$min max=$max); no se modificó el escalado"
}
traffic_snapshot() { jq -S -c '.properties.configuration.ingress.traffic // []' "$1"; }
traffic_is_revision() { jq -e --arg revision "$2" '.properties.configuration.ingress.traffic | type == "array" and length == 1 and .[0].revisionName == $revision and .[0].weight == 100 and .[0].latestRevision != true' "$1" >/dev/null; }
set_traffic_revision() {
  local revision="$1"
  az containerapp ingress traffic set --subscription "$SUBSCRIPTION" --name "$app" --resource-group "$RESOURCE_GROUP" --revision-weight "$revision=100" --output none
}
verify_revision() {
  local expected="$1" deadline_attempts="${ACA_POLL_ATTEMPTS:-30}" delay="${ACA_POLL_INTERVAL_SECONDS:-10}" attempt current latest ready revision_image health active running replicas min_replicas provisioning
  revision_verify_detail='no se pudo leer el estado ACA'
  for ((attempt=1; attempt<=deadline_attempts; attempt++)); do
    read_app > "$after" || { sleep "$delay"; continue; }
    current="$(container_image "$after" 2>/dev/null || true)"
    latest="$(jq -r '.properties.latestRevisionName // empty' "$after")"
    ready="$(jq -r '.properties.latestReadyRevisionName // empty' "$after")"
    revision_verify_detail="imagen_template=${current:-desconocida} latest=${latest:-ausente} latestReady=${ready:-ausente}"
    if [[ "$current" == "$expected" && -n "$latest" && "$latest" == "$ready" ]] && revision_health "$latest" "$revision"; then
      revision_image="$(container_image "$revision" 2>/dev/null || true)"
      health="$(jq -r '.properties.healthState // empty' "$revision")"
      active="$(jq -r '.properties.active // false' "$revision")"
      running="$(jq -r '.properties.runningState // empty' "$revision")"
      replicas="$(jq -r '.properties.replicas // -1' "$revision")"
      min_replicas="$(jq -r '.properties.template.scale.minReplicas // -1' "$revision")"
      provisioning="$(jq -r '.properties.provisioningState // empty' "$revision")"
      revision_verify_detail="revision=$latest image=${revision_image:-desconocida} active=$active health=${health:-desconocida} running=${running:-desconocido} replicas=$replicas minReplicas=$min_replicas provisioning=${provisioning:-desconocido}"
      local revision_min revision_max
      revision_min="$(jq -r '.properties.template.scale.minReplicas // 0' "$revision")"
      revision_max="$(jq -r '.properties.template.scale.maxReplicas // 0' "$revision")"
      if chile_hot_service && [[ "$revision_min" != 1 || "$revision_max" != 1 ]]; then
        revision_verify_detail+=" expected_scale=1/1"
      elif [[ "$revision_image" == "$expected" && "$active" == true && ( "$running" == Running || "$running" == RunningAtMaxScale ) && "$replicas" =~ ^[1-9][0-9]*$ && "$health" == Healthy && "$provisioning" == Provisioned ]]; then
        verified_mode=running; verified_replicas="$replicas"; verified_health="$health"
        return 0
      fi
      if ! chile_hot_service && [[ "$revision_image" == "$expected" && "$active" == true && ( "$running" == Stopped || "$running" == ScaledToZero ) && "$replicas" == 0 && "$min_replicas" == 0 && "$provisioning" == Provisioned && ( "$health" == None || "$health" == Healthy ) ]]; then
        verified_mode=scale-to-zero; verified_replicas=0; verified_health="$health"
        return 0
      fi
    fi
    sleep "$delay"
  done
  return 1
}

get_chile_origin() {
  local app_json ingress fqdn external expected_external
  app_json="$(read_app)" || fail 'no se pudo validar el ingress ACA Chile'
  ingress="$(jq -c '.properties.configuration.ingress // empty' <<< "$app_json")"
  fqdn="$(jq -r '.fqdn // empty' <<< "$ingress")"
  external="$(jq -r '.external // false' <<< "$ingress")"
  expected_external=false
  [[ "$service" != api-gateway ]] || expected_external=true
  [[ -n "$fqdn" && "$external" == "$expected_external" && "$(jq -r '.allowInsecure' <<< "$ingress")" == false ]] || fail 'FQDN/ingress del servicio Chile no coincide con el ingress autorizado'
  printf 'https://%s\n' "$fqdn"
}

verify_g5_gateway_default_route() {
  local app_json="$1" expected_revision="$2"
  jq -e --arg rev "$expected_revision" '
    [.properties.configuration.ingress.traffic[]? | select((.label // "") == "")] as $routes
    | ($routes | length) == 1 and $routes[0].revisionName == $rev and $routes[0].weight == 100 and ($routes[0].latestRevision // false) == false
  ' <<< "$app_json" >/dev/null
}

verify_g5_gateway_revision() {
  local expected="$1" marketplace_revision="$2" require_label="${3:-true}" app_json latest ready traffic default_routes label_routes revision_json="$work/g5-revision.json" image flag_count fqdn suffix health active running replicas min_replicas provisioning
  g5_route_verify_detail='no se pudo leer ACA'
  app_json="$(read_app)" || return 1
  latest="$(jq -r '.properties.latestRevisionName // empty' <<< "$app_json")"
  ready="$(jq -r '.properties.latestReadyRevisionName // empty' <<< "$app_json")"
  [[ -n "$latest" && "$latest" == "$ready" ]] || { g5_route_verify_detail="latest=$latest ready=$ready"; return 1; }
  revision_health "$latest" "$revision_json" || { g5_route_verify_detail='no se leyó la revisión objetivo'; return 1; }
  image="$(container_image "$revision_json" 2>/dev/null || true)"
  health="$(jq -r '.properties.healthState // empty' "$revision_json")"
  active="$(jq -r '.properties.active // false' "$revision_json")"
  running="$(jq -r '.properties.runningState // empty' "$revision_json")"
  replicas="$(jq -r '.properties.replicas // -1' "$revision_json")"
  min_replicas="$(jq -r '.properties.template.scale.minReplicas // -1' "$revision_json")"
  provisioning="$(jq -r '.properties.provisioningState // empty' "$revision_json")"
  if [[ "$running" == Running && "$replicas" =~ ^[1-9][0-9]*$ && "$health" == Healthy && "$provisioning" == Provisioned ]]; then
    :
  elif [[ ( "$running" == Stopped || "$running" == ScaledToZero ) && "$replicas" == 0 && "$min_replicas" == 0 && ( "$health" == None || "$health" == Healthy ) && "$provisioning" == Provisioned ]]; then
    :
  else
    g5_route_verify_detail="revision=$latest digest=$(printf '%s' "$image" | sed 's/.*@//') health=$health running=$running replicas=$replicas minReplicas=$min_replicas provisioning=$provisioning"
    return 1
  fi
  [[ "$image" == "$expected" && "$active" == true ]] || { g5_route_verify_detail="revision=$latest digest=$(printf '%s' "$image" | sed 's/.*@//') active=$active"; return 1; }
  flag_count="$(jq '[.properties.template.containers[] | select(.name == "api-gateway") | .env[]? | select(.name == "GATEWAY_G5_H5_ENABLED" and .value == "true")] | length' "$revision_json")"
  [[ "$flag_count" == 1 ]] || { g5_route_verify_detail="revision=$latest GATEWAY_G5_H5_ENABLED entries=$flag_count"; return 1; }
  traffic="$(jq -c '.properties.configuration.ingress.traffic // []' <<< "$app_json")"
  default_routes="$(jq -c '[.[] | select((.label // "") == "")]' <<< "$traffic")"
  label_routes="$(jq -c '[.[] | select(.label == "g5-h5")]' <<< "$traffic")"
  jq -e --arg rev "$marketplace_revision" 'length == 1 and .[0].revisionName == $rev and .[0].weight == 100 and (.[0].latestRevision // false) == false' <<< "$default_routes" >/dev/null || { g5_route_verify_detail="default traffic route mismatch expected=$marketplace_revision routes=$default_routes"; return 1; }
  if [[ "$require_label" == true ]]; then
    jq -e --arg rev "$latest" 'length == 1 and .[0].revisionName == $rev' <<< "$label_routes" >/dev/null || { g5_route_verify_detail="label routes mismatch expected=$latest routes=$label_routes"; return 1; }
  else
    [[ "$(jq 'length' <<< "$label_routes")" == 0 ]] || { g5_route_verify_detail="unexpected G5 labels=$label_routes"; return 1; }
  fi
  fqdn="$(jq -r '.properties.configuration.ingress.fqdn // empty' <<< "$app_json")"
  [[ "$fqdn" == api-gateway.* ]] || { g5_route_verify_detail="unexpected default fqdn=$fqdn"; return 1; }
  suffix="${fqdn#api-gateway.}"
  verified_served_revision="$latest"
  verified_served_digest="${expected##*@}"
  verified_label_url="https://api-gateway---g5-h5.$suffix"
}

remove_g5_gateway_label() {
  local app_json latest labels
  app_json="$(read_app)" || return 1
  latest="$(jq -r '.properties.latestRevisionName // empty' <<< "$app_json")"
  labels="$(jq '[.properties.configuration.ingress.traffic[]? | select(.label == "g5-h5")] | length' <<< "$app_json")"
  [[ "$labels" == 0 ]] && return 0
  [[ -n "$latest" && "$(jq -r --arg latest "$latest" '[.properties.configuration.ingress.traffic[]? | select(.label == "g5-h5" and .revisionName == $latest)] | length' <<< "$app_json")" == 1 ]] || return 1
  az containerapp revision label remove --subscription "$SUBSCRIPTION" --name "$app" --resource-group "$RESOURCE_GROUP" --label g5-h5 --revision "$latest" --output none
}

restore_g5_gateway_revision() {
  local previous_image="$1" target_image="$2" marketplace_revision="$3" require_label="${4:-true}" app_json latest flag_count current
  app_json="$(read_app)" || return 1
  printf '%s\n' "$app_json" > "$after"
  current="$(container_image "$after" 2>/dev/null || true)"
  [[ "$current" == "$target_image" ]] || return 1
  verify_g5_gateway_revision "$target_image" "$marketplace_revision" "$require_label" || return 1
  remove_g5_gateway_label || return 1
  az containerapp update --subscription "$SUBSCRIPTION" --name "$app" --resource-group "$RESOURCE_GROUP" --container-name "$container" --image "$previous_image" --remove-env-vars GATEWAY_G5_H5_ENABLED --output none || return 1
  verify_revision "$previous_image" || return 1
  app_json="$(read_app)" || return 1
  latest="$(jq -r '.properties.latestRevisionName // empty' <<< "$app_json")"
  flag_count="$(jq '[.properties.template.containers[] | select(.name == "api-gateway") | .env[]? | select(.name == "GATEWAY_G5_H5_ENABLED")] | length' <<< "$app_json")"
  [[ "$flag_count" == 0 ]] || return 1
  verify_g5_gateway_default_route "$app_json" "$marketplace_revision" || return 1
  [[ "$(jq '[.properties.configuration.ingress.traffic[]? | select(.label == "g5-h5")] | length' <<< "$app_json")" == 0 ]]
}

verify_chile_served_revision() {
  local expected="$1" app_json mode latest ready traffic served_revision served_weight revision_json="$work/served-revision.json" revision_image
  app_json="$(read_app)" || return 1
  mode="$(jq -r '.properties.configuration.activeRevisionsMode // empty' <<< "$app_json")"
  latest="$(jq -r '.properties.latestRevisionName // empty' <<< "$app_json")"
  ready="$(jq -r '.properties.latestReadyRevisionName // empty' <<< "$app_json")"
  traffic="$(jq -c '.properties.configuration.ingress.traffic // []' <<< "$app_json")"
  case "$service:$mode" in
    api-gateway:Multiple|promotions-svc:Single|bulk-svc:Single|bulk-svc:Multiple|catalog-svc:Single|catalog-svc:Multiple|combos-svc:Single|combos-svc:Multiple|inventory-svc:Single|inventory-svc:Multiple|price-audit-svc:Single|price-audit-svc:Multiple|pricing-svc:Single|pricing-svc:Multiple|taxonomy-svc:Single|taxonomy-svc:Multiple) ;;
    *) return 1 ;;
  esac
  [[ -n "$latest" && "$ready" == "$latest" ]] || return 1
  [[ "$(jq 'type == "array" and length == 1' <<< "$traffic")" == true ]] || return 1
  served_revision="$(jq -r --arg latest "$latest" 'if .[0].latestRevision == true then $latest else (.[0].revisionName // empty) end' <<< "$traffic")"
  served_weight="$(jq -r '.[0].weight // 0' <<< "$traffic")"
  [[ -n "$served_revision" && "$served_revision" == "$latest" && "$served_weight" == 100 ]] || return 1
  revision_health "$served_revision" "$revision_json" || return 1
  revision_image="$(container_image "$revision_json" 2>/dev/null || true)"
  [[ "$revision_image" == "$expected" ]] || return 1
  verified_served_revision="$served_revision"
  verified_served_digest="${expected##*@}"
}

verify_chile_gateway_current_traffic() {
  local expected="$1" app_json traffic served_revision weight revision_json="$work/current-traffic-revision.json" revision_image active health running replicas provisioning min max
  app_json="$(read_app)" || return 1
  [[ "$(jq -r '.properties.configuration.activeRevisionsMode // empty' <<< "$app_json")" == Multiple ]] || return 1
  traffic="$(jq -c '.properties.configuration.ingress.traffic // []' <<< "$app_json")"
  [[ "$(jq 'type == "array" and length == 1' <<< "$traffic")" == true ]] || return 1
  served_revision="$(jq -r --arg latest "$(jq -r '.properties.latestRevisionName // empty' <<< "$app_json")" 'if .[0].latestRevision == true then $latest else (.[0].revisionName // empty) end' <<< "$traffic")"
  weight="$(jq -r '.[0].weight // 0' <<< "$traffic")"
  [[ -n "$served_revision" && "$weight" == 100 ]] || return 1
  revision_health "$served_revision" "$revision_json" || return 1
  revision_image="$(container_image "$revision_json" 2>/dev/null || true)"
  active="$(jq -r '.properties.active // false' "$revision_json")"
  health="$(jq -r '.properties.healthState // empty' "$revision_json")"
  running="$(jq -r '.properties.runningState // empty' "$revision_json")"
  replicas="$(jq -r '.properties.replicas // 0' "$revision_json")"
  provisioning="$(jq -r '.properties.provisioningState // empty' "$revision_json")"
  min="$(jq -r '.properties.template.scale.minReplicas // 0' "$revision_json")"
  max="$(jq -r '.properties.template.scale.maxReplicas // 0' "$revision_json")"
  [[ "$revision_image" == "$expected" && "$active" == true && "$health" == Healthy && ( "$running" == Running || "$running" == RunningAtMaxScale ) && "$replicas" =~ ^[1-9][0-9]*$ && "$provisioning" == Provisioned && "$min" == 1 && "$max" == 1 ]] || { printf 'Gateway traffic check: revision=%s image=%s active=%s health=%s running=%s replicas=%s provisioning=%s scale=%s/%s expected=%s\n' "$served_revision" "$revision_image" "$active" "$health" "$running" "$replicas" "$provisioning" "$min" "$max" "$expected" >&2; return 1; }
  verified_served_revision="$served_revision"
  verified_served_digest="${expected##*@}"
}

recover_chile_gateway_template() {
  local current_image
  verify_chile_gateway_current_traffic "$previous_image" || fail 'RECUPERACIÓN OMITIDA: revisión anterior no sigue saludable, servida y escalada 1/1'
  read_app > "$after" || fail 'RECUPERACIÓN OMITIDA: no se pudo releer Gateway antes de restaurar la plantilla'
  normalize_app "$after" > "$work/pre-template-recovery-normalized.json"
  cmp -s "$work/before-normalized.json" "$work/pre-template-recovery-normalized.json" || fail 'RECUPERACIÓN OMITIDA: configuración cambió antes de restaurar la plantilla'
  current_image="$(container_image "$after")"
  [[ "$current_image" == "$image" ]] || fail 'RECUPERACIÓN OMITIDA: digest de plantilla cambió concurrentemente'
  traffic_is_revision "$after" "$previous_served_revision" || fail 'RECUPERACIÓN OMITIDA: tráfico cambió antes de restaurar la plantilla'
  az containerapp update --subscription "$SUBSCRIPTION" --name "$app" --resource-group "$RESOURCE_GROUP" --container-name "$container" --image "$previous_image" --output none || fail 'RECUPERACIÓN INCOMPLETA: Azure rechazó restaurar el digest anterior en la plantilla; ruta anterior permanece servida'
  verify_revision "$previous_image" || fail "RECUPERACIÓN INCOMPLETA: plantilla anterior aplicada pero revisión latest no Healthy: $revision_verify_detail"
  read_app > "$after" || fail 'RECUPERACIÓN INCOMPLETA: no se pudo verificar la plantilla restaurada'
  normalize_app "$after" > "$work/post-template-recovery-normalized.json"
  cmp -s "$work/before-normalized.json" "$work/post-template-recovery-normalized.json" || fail 'RECUPERACIÓN INCOMPLETA: configuración cambió durante la restauración de plantilla'
  [[ "$(container_image "$after")" == "$previous_image" ]] || fail 'RECUPERACIÓN INCOMPLETA: plantilla no conserva el digest anterior'
  traffic_is_revision "$after" "$previous_served_revision" || fail 'RECUPERACIÓN INCOMPLETA: tráfico cambió durante la restauración de plantilla'
  verify_chile_gateway_current_traffic "$previous_image" || fail 'RECUPERACIÓN INCOMPLETA: la ruta anterior perdió salud o escala 1/1'
  printf 'PLANTILLA RECUPERADA: Gateway sirve revisión anterior %s; siguiente despliegue puede reintentarse.\n' "$previous_served_revision" >&2
}

verify_chile_transition_traffic() {
  local target_image="$1" previous_image="$2" previous_revision="$3" app_json mode latest traffic served_revision served_weight revision_json="$work/transition-revision.json" revision_image active
  app_json="$(read_app)" || return 1
  mode="$(jq -r '.properties.configuration.activeRevisionsMode // empty' <<< "$app_json")"
  latest="$(jq -r '.properties.latestRevisionName // empty' <<< "$app_json")"
  traffic="$(jq -c '.properties.configuration.ingress.traffic // []' <<< "$app_json")"
  case "$service:$mode" in
    api-gateway:Multiple|promotions-svc:Single|bulk-svc:Single|bulk-svc:Multiple|catalog-svc:Single|catalog-svc:Multiple|combos-svc:Single|combos-svc:Multiple|inventory-svc:Single|inventory-svc:Multiple|price-audit-svc:Single|price-audit-svc:Multiple|pricing-svc:Single|pricing-svc:Multiple|taxonomy-svc:Single|taxonomy-svc:Multiple) ;;
    *) return 1 ;;
  esac
  [[ -n "$latest" ]] || return 1
  [[ "$(jq 'type == "array" and length == 1' <<< "$traffic")" == true ]] || return 1
  served_revision="$(jq -r --arg latest "$latest" 'if .[0].latestRevision == true then $latest else (.[0].revisionName // empty) end' <<< "$traffic")"
  served_weight="$(jq -r '.[0].weight // 0' <<< "$traffic")"
  [[ "$served_weight" == 100 && -n "$served_revision" ]] || return 1
  revision_health "$served_revision" "$revision_json" || return 1
  revision_image="$(container_image "$revision_json" 2>/dev/null || true)"
  active="$(jq -r '.properties.active // false' "$revision_json")"
  [[ "$active" == true ]] || return 1
  if [[ "$served_revision" == "$latest" && "$revision_image" == "$target_image" ]]; then
    return 0
  fi
  if [[ "$served_revision" == "$previous_revision" && "$revision_image" == "$previous_image" ]]; then
    return 0
  fi
  return 1
}

if [[ "$mode" == inspect ]]; then
  validate_target
  read_app > "$before" || { echo 'INSPECTION_UNKNOWN: no se pudo leer ACA.'; exit 2; }
  current="$(container_image "$before" 2>/dev/null || true)"
  if [[ "$current" == "$image" ]]; then
    printf 'TARGET_ACTIVE: %s\n' "$service"
  elif [[ "$current" == "$REPOSITORY/$service@sha256:"* && "${current##*@sha256:}" =~ ^[0-9a-f]{64}$ ]]; then
    printf 'TARGET_NOT_ACTIVE: %s current=%s\n' "$service" "$current"
  else
    printf 'INSPECTION_UNKNOWN: imagen actual ausente/no verificable para %s.\n' "$service"
    exit 2
  fi
  exit 0
fi

if [[ "$mode" == restore ]]; then
  validate_target
  read_app > "$before" || fail 'no se pudo inspeccionar ACA para recuperación'
  verify_chile_scale "$before"
  current="$(container_image "$before")" || fail 'no se pudo verificar imagen actual'
  if [[ "$gateway_route_profile" == g5-labelled ]]; then
    marketplace_revision="${H5_G5_MARKETPLACE_REVISION:-}"
    [[ "$marketplace_revision" =~ ^api-gateway--[a-zA-Z0-9-]+$ ]] || fail 'recibo de Gateway etiquetado sin revisión Marketplace verificable'
    if [[ "$current" == "$previous_image" ]]; then
      verify_revision "$previous_image" || fail 'RECUPERACIÓN NO VERIFICADA: revisión anterior no está Healthy'
      read_app > "$after" || fail 'RECUPERACIÓN NO VERIFICADA: no se pudo releer ACA'
      [[ "$(jq '[.properties.template.containers[] | select(.name == "api-gateway") | .env[]? | select(.name == "GATEWAY_G5_H5_ENABLED")] | length' "$after")" == 0 ]] || fail 'RECUPERACIÓN NO VERIFICADA: flag G5 sigue en el template'
      verify_g5_gateway_default_route "$(cat "$after")" "$marketplace_revision" || fail 'RECUPERACIÓN NO VERIFICADA: ruta Marketplace cambió'
      [[ "$(jq '[.properties.configuration.ingress.traffic[]? | select(.label == "g5-h5")] | length' "$after")" == 0 ]] || fail 'RECUPERACIÓN NO VERIFICADA: label G5 sigue asignado'
    fi
  elif [[ "$destination" == chile-shared && "$current" == "$previous_image" && "$service" != api-gateway ]]; then
    verify_chile_served_revision "$previous_image" || fail 'RECUPERACIÓN NO VERIFICADA: el digest anterior no recibe el 100% del tráfico Chile'
  fi
  if [[ "$gateway_route_profile" != g5-labelled && "$destination" == chile-shared && "$service" == api-gateway && "$current" != "$previous_image" ]]; then
    verify_chile_served_revision "$current" || fail 'RECUPERACIÓN OMITIDA: Gateway no sirve de forma exclusiva la revisión aplicada'
    restore_served_revision="$verified_served_revision"
    restore_traffic="$(traffic_snapshot "$before")"
  fi
  normalize_app "$before" > "$work/current-normalized.json"
  current_hash="$(sha256sum "$work/current-normalized.json" | awk '{print $1}')"
  if [[ "$current" == "$previous_image" && "$current_hash" == "$expected_config_hash" ]]; then
    if [[ "$gateway_route_profile" != g5-labelled && "$destination" == chile-shared && "$service" == api-gateway ]]; then
      verify_chile_gateway_current_traffic "$previous_image" || fail 'RECUPERACIÓN NO VERIFICADA: Gateway no sirve al 100% una revisión saludable con el digest anterior y escala 1/1'
    fi
    printf 'RECUPERACIÓN YA PRESENTE: servicio=%s conserva digest anterior y configuración.\n' "$service"
    exit 0
  fi
  [[ "$current" == "$image" && "$current_hash" == "$expected_config_hash" ]] || {
    printf 'RECUPERACIÓN OMITIDA: %s cambió concurrentemente (imagen/configuración); no se sobrescribe. Revisión manual requerida.\n' "$service" >&2
    exit 1
  }
  if [[ "$gateway_route_profile" == g5-labelled ]]; then
    restore_g5_gateway_revision "$previous_image" "$image" "$marketplace_revision" || fail 'RECUPERACIÓN NO VERIFICADA: Gateway conserva su URL Marketplace y el rollback del label G5 no pudo acreditarse'
    normalize_app "$after" > "$work/after-normalized.json"
    cmp -s "$work/current-normalized.json" "$work/after-normalized.json" || fail 'la configuración cambió durante la recuperación de Gateway etiquetado'
    printf 'ROLLBACK COORDINADO VERIFICADO: servicio=%s revision=%s image=%s Marketplace_revision=%s.\n' "$service" "$(jq -r '.properties.latestRevisionName' "$after")" "$previous_image" "$marketplace_revision"
    exit 0
  fi
  if [[ "$destination" == chile-shared && "$service" == api-gateway ]]; then
    read_app > "$after" || fail 'no se pudo releer Gateway antes de recuperación'
    normalize_app "$after" > "$work/restore-pre-pin-normalized.json"
    cmp -s "$work/current-normalized.json" "$work/restore-pre-pin-normalized.json" || fail 'RECUPERACIÓN OMITIDA: configuración cambió antes de fijar tráfico'
    [[ "$(traffic_snapshot "$after")" == "$restore_traffic" ]] || fail 'RECUPERACIÓN OMITIDA: tráfico cambió concurrentemente antes del pinning'
    set_traffic_revision "$restore_served_revision" || fail 'no se pudo fijar revisión actual antes de la recuperación Gateway'
    read_app > "$after" || fail 'no se pudo releer Gateway tras fijar tráfico de recuperación'
    traffic_is_revision "$after" "$restore_served_revision" || fail 'RECUPERACIÓN OMITIDA: el tráfico cambió durante el pinning'
    normalize_app "$after" > "$work/restore-pinned-normalized.json"
    cmp -s "$work/current-normalized.json" "$work/restore-pinned-normalized.json" || fail 'RECUPERACIÓN OMITIDA: configuración cambió durante el pinning'
  fi
  az containerapp update --subscription "$SUBSCRIPTION" --name "$app" --resource-group "$RESOURCE_GROUP" --container-name "$container" --image "$previous_image" --output none || fail 'Azure rechazó la recuperación'
  verify_revision "$previous_image" || fail 'revisión de recuperación no Healthy'
  if [[ "$destination" == chile-shared ]]; then
    if [[ "$service" == api-gateway ]]; then
      read_app > "$after" || fail 'no se pudo comprobar el tráfico durante recuperación Gateway'
      normalize_app "$after" > "$work/restore-normalized.json"
      cmp -s "$work/current-normalized.json" "$work/restore-normalized.json" || fail 'RECUPERACIÓN OMITIDA: configuración cambió concurrentemente'
      traffic_is_revision "$after" "$restore_served_revision" || fail 'RECUPERACIÓN OMITIDA: tráfico cambió concurrentemente'
      restore_candidate_revision="$(jq -r '.properties.latestRevisionName' "$after")"
      set_traffic_revision "$restore_candidate_revision" || fail 'Azure rechazó recuperar el tráfico de Gateway'
    fi
    verify_chile_served_revision "$previous_image" || fail 'RECUPERACIÓN NO VERIFICADA: el digest anterior no recibe el 100% del tráfico Chile'
  fi
  normalize_app "$after" > "$work/after-normalized.json"
  cmp -s "$work/current-normalized.json" "$work/after-normalized.json" || fail 'la configuración cambió durante la recuperación'
  printf 'ROLLBACK COORDINADO VERIFICADO: servicio=%s revision=%s image=%s.\n' "$service" "$(jq -r '.properties.latestRevisionName' "$after")" "$previous_image"
  exit 0
fi

validate_target
read_app > "$before" || fail "no se pudo inspeccionar ACA ${app}"
verify_chile_scale "$before"
jq -e '.properties.template.containers | type == "array" and length > 0' "$before" >/dev/null || fail 'respuesta ACA sin lista de contenedores válida'
if [[ "$service" == api-gateway ]]; then
  jq -e '[.properties.template.containers[] | select(.name == "caddy")] | length == 1' "$before" >/dev/null || fail 'Gateway no contiene exactamente un sidecar caddy; actualización cancelada'
fi
previous_image="$(container_image "$before")" || fail 'no se encontró exactamente un contenedor de destino'
[[ "$previous_image" == "$REPOSITORY/$service@sha256:"* && "${previous_image##*@sha256:}" =~ ^[0-9a-f]{64}$ ]] || fail 'la imagen previa no es un digest oficial verificable; rollback seguro imposible'
if [[ "$gateway_route_profile" == g5-labelled ]]; then
  marketplace_traffic="$(jq -c '[.properties.configuration.ingress.traffic[]? | select((.label // "") == "")]' "$before")"
  jq -e 'length == 1 and .[0].revisionName != null and .[0].weight == 100 and (.[0].latestRevision // false) == false' <<< "$marketplace_traffic" >/dev/null || fail 'la ruta default de Marketplace no está fijada a una revisión única al 100%; se cancela sin modificar ACA'
  previous_served_revision="$(jq -r '.[0].revisionName' <<< "$marketplace_traffic")"
  if [[ "$previous_image" != "$image" ]]; then
    verify_chile_gateway_current_traffic "$previous_image" || fail 'revisión Marketplace previa no está Healthy/servida con escala 1/1; se cancela sin modificar ACA'
  else
    verify_g5_gateway_revision "$image" "$previous_served_revision" true || fail 'revisión/label G5 existente no coincide con la ruta Marketplace fijada'
  fi
  jq -e '.properties.configuration.activeRevisionsMode == "Multiple"' "$before" >/dev/null || fail 'Gateway etiquetado requiere modo Multiple'
  if [[ "$previous_image" != "$image" ]]; then
    jq -e '[.properties.template.containers[] | select(.name == "api-gateway") | .env[]? | select(.name == "GATEWAY_G5_H5_ENABLED" and .value == "true")] | length == 0' "$before" >/dev/null || fail 'Gateway ya tiene el flag H5 habilitado; no se crea una revisión compartida'
    jq -e '[.properties.configuration.ingress.traffic[]? | select(.label == "g5-h5")] | length == 0' "$before" >/dev/null || fail 'label g5-h5 ya existe para otra revisión; se requiere conciliación explícita'
  fi
elif [[ "$destination" == chile-shared ]]; then
  if [[ "$service" == api-gateway ]]; then
    verify_chile_gateway_current_traffic "$previous_image" || fail 'tráfico Chile previo de Gateway no es una revisión única, sana y verificable; no se modifica Azure'
  else
    verify_chile_served_revision "$previous_image" || fail 'tráfico Chile previo es ambiguo/incompatible con un despliegue individual; no se modifica Azure'
  fi
  previous_served_revision="$verified_served_revision"
  previous_traffic="$(traffic_snapshot "$before")"
fi
normalize_app "$before" > "$work/before-normalized.json"
baseline_hash="$(sha256sum "$work/before-normalized.json" | awk '{print $1}')"
if [[ -n "${DEPLOY_RECEIPT:-}" ]]; then
  origin=''
  if [[ "$destination" == chile-shared ]]; then origin="$(get_chile_origin)"; fi
  jq -n --arg service "$service" --arg destination "$DESTINATION" --arg environment "$DEPLOYMENT_ENVIRONMENT" --arg run_id "${GITHUB_RUN_ID:-}" --arg resource_group "$RESOURCE_GROUP" --arg aca_environment "$ACA_ENVIRONMENT" --arg location "$REGION" --arg subscription "$SUBSCRIPTION" --arg app_id "$(jq -r '.id' "$before")" --arg container "$container" --arg previous "$previous_image" --arg target "$image" --arg config "$baseline_hash" --arg origin "$origin" --arg route_profile "$gateway_route_profile" --arg marketplace_revision "${previous_served_revision:-}" '{service:$service,destination:$destination,github_environment:$environment,workflow_run_id:$run_id,resource_group:$resource_group,aca_environment:$aca_environment,location:$location,subscription_id:$subscription,app_resource_id:$app_id,container:$container,previous:$previous,target:$target,digest_candidate:($target | split("@")[1]),origin_https:(if $origin == "" then null else $origin end),config_sha256:$config,route_profile:$route_profile,marketplace_revision:(if $route_profile == "g5-labelled" then $marketplace_revision else null end)}' > "$DEPLOY_RECEIPT"
fi

if [[ "$previous_image" == "$image" ]]; then
  printf 'Idempotencia: %s ya usa la imagen/digest solicitado; verificando revisión existente.\n' "$service"
  verify_revision "$image" || fail 'imagen ya presente, pero revisión activa no está Healthy'
  if [[ "$destination" == chile-shared ]]; then
    if [[ "$gateway_route_profile" == g5-labelled ]]; then
      verify_g5_gateway_revision "$image" "$previous_served_revision" true || fail 'revisión/label G5 no coincide con tráfico Marketplace intacto'
      [[ -n "${DEPLOY_RECEIPT:-}" ]] && jq --arg revision "$verified_served_revision" --arg digest "$verified_served_digest" --arg url "$verified_label_url" '.served_revision=$revision | .served_digest=$digest | .route_mode="revision_label" | .g5_label="g5-h5" | .g5_label_url=$url | .marketplace_traffic_weight=100' "$DEPLOY_RECEIPT" > "$DEPLOY_RECEIPT.tmp" && mv "$DEPLOY_RECEIPT.tmp" "$DEPLOY_RECEIPT"
    else
      verify_chile_served_revision "$image" || fail 'tráfico efectivo Chile no apunta exclusivamente a la revisión latest con digest candidato'
      [[ -n "${DEPLOY_RECEIPT:-}" ]] && jq --arg revision "$verified_served_revision" --arg digest "$verified_served_digest" '.served_revision=$revision | .served_digest=$digest | .traffic_weight=100' "$DEPLOY_RECEIPT" > "$DEPLOY_RECEIPT.tmp" && mv "$DEPLOY_RECEIPT.tmp" "$DEPLOY_RECEIPT"
    fi
  fi
  printf 'REVISIÓN VERIFICADA: servicio=%s modo=%s réplicas=%s salud=%s.\n' "$service" "$verified_mode" "$verified_replicas" "$verified_health"
else
  # Store only hashes and immutable image references; never serialize ACA secrets into artifacts.
  printf 'Actualizando solo %s/%s en %s; configuración ACA se comparará sin imprimirla.\n' "$app" "$container" "$RESOURCE_GROUP"
  failure_stage=''
  if [[ "$gateway_route_profile" == g5-labelled ]]; then
    if ! az containerapp update --subscription "$SUBSCRIPTION" --name "$app" --resource-group "$RESOURCE_GROUP" --container-name "$container" --image "$image" --set-env-vars GATEWAY_G5_H5_ENABLED=true --output none; then
      failure_stage='az containerapp update rechazó imagen/flag de la revisión G5'
    elif ! verify_revision "$image"; then
      failure_stage="verificación latest/ready/health/running: $revision_verify_detail"
    elif ! verify_g5_gateway_revision "$image" "$previous_served_revision" false; then
      failure_stage="revisión G5 no sana, flag H5 incorrecto o tráfico Marketplace modificado: ${g5_route_verify_detail:-sin detalle}"
    elif ! az containerapp revision label add --subscription "$SUBSCRIPTION" --name "$app" --resource-group "$RESOURCE_GROUP" --revision latest --label g5-h5 --output none; then
      failure_stage='Azure rechazó asignar label ACA g5-h5 a la revisión G5'
    elif ! verify_g5_gateway_revision "$image" "$previous_served_revision" true; then
      failure_stage="label G5 no apunta al digest/revisión objetivo o tráfico Marketplace cambió: ${g5_route_verify_detail:-sin detalle}"
    elif ! normalize_app "$after" > "$work/after-normalized.json"; then
      failure_stage='no se pudo normalizar la configuración ACA posterior al cambio'
    elif ! cmp -s "$work/before-normalized.json" "$work/after-normalized.json"; then
      failure_stage='drift de configuración persistente entre baseline y readback'
    fi
  else
    if [[ "$destination" == chile-shared && "$service" == api-gateway ]]; then
      # Freeze Multiple-mode traffic on the known-good revision before ACA creates a candidate.
      read_app > "$after" || fail 'no se pudo releer Gateway antes del pinning preventivo'
      normalize_app "$after" > "$work/pre-pin-normalized.json"
      cmp -s "$work/before-normalized.json" "$work/pre-pin-normalized.json" || fail 'cambió configuración de Gateway antes del pinning; actualización cancelada'
      [[ "$(traffic_snapshot "$after")" == "$previous_traffic" ]] || fail 'cambió concurrentemente el tráfico previo de Gateway; actualización cancelada'
      if ! set_traffic_revision "$previous_served_revision"; then
        fail 'no se pudo fijar el tráfico previo de Gateway; actualización cancelada'
      fi
      read_app > "$after" || fail 'no se pudo releer Gateway tras fijar tráfico previo'
      normalize_app "$after" > "$work/pinned-normalized.json"
      cmp -s "$work/before-normalized.json" "$work/pinned-normalized.json" || fail 'cambió configuración durante el pinning preventivo de Gateway'
      traffic_is_revision "$after" "$previous_served_revision" || fail 'cambió concurrentemente el tráfico previo de Gateway; actualización cancelada'
    fi
    if ! az containerapp update --subscription "$SUBSCRIPTION" --name "$app" --resource-group "$RESOURCE_GROUP" --container-name "$container" --image "$image" --output none; then
      failure_stage='az containerapp update rechazó el cambio de imagen'
    elif ! verify_revision "$image"; then
      failure_stage="verificación latest/ready/health/running: $revision_verify_detail"
    elif [[ "$destination" == chile-shared && "$service" != api-gateway ]] && ! verify_chile_served_revision "$image"; then
      failure_stage='revisión sana pero el modo ACA/traffic no asigna 100% a latestRevision'
    elif ! normalize_app "$after" > "$work/after-normalized.json"; then
      failure_stage='no se pudo normalizar la configuración ACA posterior al cambio'
    elif ! cmp -s "$work/before-normalized.json" "$work/after-normalized.json"; then
      failure_stage='drift de configuración persistente entre baseline y readback'
    elif [[ "$destination" == chile-shared && "$service" == api-gateway ]] && ! verify_revision "$image"; then
      failure_stage='la revisión candidata de Gateway perdió salud antes del corte'
    elif [[ "$destination" == chile-shared && "$service" == api-gateway ]] && { ! read_app > "$after" || ! traffic_is_revision "$after" "$previous_served_revision" || ! normalize_app "$after" > "$work/pre-cutover-normalized.json" || ! cmp -s "$work/before-normalized.json" "$work/pre-cutover-normalized.json"; }; then
      failure_stage='cambio concurrente o tráfico inesperado antes del corte de Gateway'
    elif [[ "$destination" == chile-shared && "$service" == api-gateway ]] && ! set_traffic_revision "$(jq -r '.properties.latestRevisionName' "$after")"; then
      failure_stage='Azure rechazó el corte controlado de tráfico de Gateway'
    elif [[ "$destination" == chile-shared ]] && ! verify_chile_served_revision "$image"; then
      failure_stage='tráfico efectivo Chile no apunta exclusivamente a la revisión sana con digest candidato'
    elif [[ "$destination" == chile-shared && "$service" == api-gateway ]] && ! verify_revision "$image"; then
      failure_stage="revisión servida de Gateway perdió salud tras el corte: $revision_verify_detail"
    elif [[ "$destination" == chile-shared && "$service" == api-gateway ]] && { ! read_app > "$after" || ! normalize_app "$after" > "$work/after-cutover-normalized.json"; }; then
      failure_stage='no se pudo verificar configuración posterior al corte de Gateway'
    elif [[ "$destination" == chile-shared && "$service" == api-gateway ]] && ! cmp -s "$work/before-normalized.json" "$work/after-cutover-normalized.json"; then
      failure_stage='cambió configuración durante el corte de tráfico de Gateway'
    elif [[ "$destination" == chile-shared ]] && ! verify_chile_served_revision "$image"; then
      failure_stage='el tráfico Chile cambió durante la verificación final'
    fi
  fi
  if [[ -z "$failure_stage" ]]; then
    if [[ "$destination" == chile-shared && -n "${DEPLOY_RECEIPT:-}" ]]; then
      if [[ "$gateway_route_profile" == g5-labelled ]]; then
        jq --arg revision "$verified_served_revision" --arg digest "$verified_served_digest" --arg url "$verified_label_url" '.served_revision=$revision | .served_digest=$digest | .route_mode="revision_label" | .g5_label="g5-h5" | .g5_label_url=$url | .marketplace_traffic_weight=100' "$DEPLOY_RECEIPT" > "$DEPLOY_RECEIPT.tmp" && mv "$DEPLOY_RECEIPT.tmp" "$DEPLOY_RECEIPT"
      else
        jq --arg revision "$verified_served_revision" --arg digest "$verified_served_digest" '.served_revision=$revision | .served_digest=$digest | .traffic_weight=100' "$DEPLOY_RECEIPT" > "$DEPLOY_RECEIPT.tmp" && mv "$DEPLOY_RECEIPT.tmp" "$DEPLOY_RECEIPT"
      fi
    fi
    printf 'Despliegue verificado: servicio=%s revision=%s image=%s modo=%s réplicas=%s salud=%s.\n' "$service" "$(jq -r '.properties.latestRevisionName' "$after")" "$image" "$verified_mode" "$verified_replicas" "$verified_health"
    exit 0
  fi

  printf 'Fallo tras actualización de %s; etapa=%s.\n' "$service" "$failure_stage" >&2
  read_app > "$after" || fail 'ROLLBACK NO VERIFICADO: no se pudo releer ACA; revisar manualmente'
  if [[ "$gateway_route_profile" != g5-labelled && "$destination" == chile-shared && "$service" == api-gateway ]]; then
    normalize_app "$after" > "$work/failure-normalized.json" || fail 'RECUPERACIÓN NO VERIFICADA: no se pudo comparar configuración'
    cmp -s "$work/before-normalized.json" "$work/failure-normalized.json" || fail 'RECUPERACIÓN OMITIDA: configuración cambió concurrentemente'
    current="$(container_image "$after" 2>/dev/null || true)"
    if [[ "$current" == "$previous_image" ]]; then
      traffic_is_revision "$after" "$previous_served_revision" || fail 'RECUPERACIÓN OMITIDA: tráfico cambió concurrentemente; no se sobrescribe'
      verify_chile_gateway_current_traffic "$previous_image" || fail 'RECUPERACIÓN NO VERIFICADA: revisión anterior perdió salud o escala 1/1'
      printf 'ACTUALIZACIÓN NO APLICADA: Gateway conserva digest, configuración y ruta previos.\n' >&2
      exit 1
    fi
    [[ "$current" == "$image" ]] || fail 'RECUPERACIÓN OMITIDA: digest de plantilla cambió concurrentemente'
    candidate_revision="$(jq -r '.properties.latestRevisionName' "$after")"
    if traffic_is_revision "$after" "$candidate_revision"; then
      set_traffic_revision "$previous_served_revision" || fail 'RECUPERACIÓN NO VERIFICADA: no se pudo restaurar el tráfico a la revisión anterior'
      read_app > "$after" || fail 'RECUPERACIÓN NO VERIFICADA: no se pudo releer el tráfico restaurado'
      traffic_is_revision "$after" "$previous_served_revision" || fail 'RECUPERACIÓN NO VERIFICADA: tráfico posterior no coincide con la revisión anterior'
      normalize_app "$after" > "$work/recovered-normalized.json"
      cmp -s "$work/before-normalized.json" "$work/recovered-normalized.json" || fail 'RECUPERACIÓN NO VERIFICADA: configuración cambió durante recuperación'
      recover_chile_gateway_template
      exit 1
    fi
    traffic_is_revision "$after" "$previous_served_revision" || fail 'RECUPERACIÓN OMITIDA: tráfico cambió concurrentemente; no se sobrescribe'
    printf 'TRÁFICO PREVIO CONSERVADO: Gateway mantiene revisión %s.\n' "$previous_served_revision" >&2
    recover_chile_gateway_template
    exit 1
  fi
  current="$(container_image "$after" 2>/dev/null || true)"
  normalize_app "$after" > "$work/failure-normalized.json" || fail 'ROLLBACK NO VERIFICADO: no se pudo comparar la configuración persistente'
  failure_hash="$(sha256sum "$work/failure-normalized.json" | awk '{print $1}')"
  if [[ "$gateway_route_profile" == g5-labelled && "$current" == "$previous_image" && "$failure_hash" == "$baseline_hash" ]]; then
    verify_g5_gateway_default_route "$(cat "$after")" "$previous_served_revision" || fail 'Gateway cambió el tráfico Marketplace tras rechazar la actualización; inspección requerida'
    [[ "$(jq '[.properties.configuration.ingress.traffic[]? | select(.label == "g5-h5")] | length' "$after")" == 0 ]] || fail 'actualización rechazada dejó un label G5 inesperado; inspección requerida'
    printf 'ACTUALIZACIÓN NO APLICADA: Gateway conserva imagen/configuración y ruta Marketplace previas.\n' >&2
    exit 1
  fi
  if [[ "$failure_stage" == 'az containerapp update rechazó el cambio de imagen' && "$current" == "$previous_image" && "$failure_hash" == "$baseline_hash" ]]; then
    if [[ "$destination" != chile-shared ]] || verify_chile_served_revision "$previous_image"; then
      printf 'ACTUALIZACIÓN NO APLICADA: ACA conserva imagen, configuración y tráfico previos; no se ejecutó rollback.\n' >&2
      exit 1
    fi
    printf 'ROLLBACK OMITIDO: la actualización fue rechazada y el tráfico previo de Chile ya no es verificable.\n' >&2
    exit 1
  fi
  if [[ "$current" != "$image" ]]; then
    printf 'ROLLBACK OMITIDO: drift de imagen; esperada=%s actual=%s. Revisar ACA manualmente.\n' "$image" "${current:-desconocida}" >&2
    exit 1
  fi
  if [[ "$failure_hash" != "$baseline_hash" ]]; then
    printf 'ROLLBACK OMITIDO: drift de configuración persistente en %s; no se sobrescriben cambios ajenos.\n' "$service" >&2
    exit 1
  fi
  if [[ "$gateway_route_profile" == g5-labelled ]]; then
    require_label=true
    [[ "$failure_stage" == 'Azure rechazó asignar label ACA g5-h5 a la revisión G5' ]] && require_label=false
    if ! verify_g5_gateway_revision "$image" "$previous_served_revision" "$require_label"; then
      printf 'ROLLBACK OMITIDO: revisión/label G5 o tráfico Marketplace presenta drift; no se sobrescribe el enrutamiento.\n' >&2
      exit 1
    fi
  elif [[ "$destination" == chile-shared ]] && ! verify_chile_transition_traffic "$image" "$previous_image" "$previous_served_revision"; then
    printf 'ROLLBACK OMITIDO: drift o tráfico ambiguo de Chile; no se sobrescribe el enrutamiento.\n' >&2
    exit 1
  fi
  if [[ "$gateway_route_profile" == g5-labelled ]]; then
    require_label=true
    [[ "$failure_stage" == 'Azure rechazó asignar label ACA g5-h5 a la revisión G5' ]] && require_label=false
    if restore_g5_gateway_revision "$previous_image" "$image" "$previous_served_revision" "$require_label"; then
      normalize_app "$after" > "$work/rollback-normalized.json"
      cmp -s "$work/before-normalized.json" "$work/rollback-normalized.json" || fail 'rollback cambió configuración fuera del flag G5'
      printf 'ROLLBACK VERIFICADO: Gateway conserva revisión Marketplace=%s; flag y label H5 retirados.\n' "$previous_served_revision" >&2
    else
      printf 'ROLLBACK NO VERIFICADO: Gateway; revisar manualmente antes de reintentar.\n' >&2
    fi
    exit 1
  elif az containerapp update --subscription "$SUBSCRIPTION" --name "$app" --resource-group "$RESOURCE_GROUP" --container-name "$container" --image "$previous_image" --output none && \
     verify_revision "$previous_image" && { [[ "$destination" != chile-shared ]] || verify_chile_served_revision "$previous_image"; } && normalize_app "$after" > "$work/rollback-normalized.json" && \
     cmp -s "$work/before-normalized.json" "$work/rollback-normalized.json"; then
    printf 'ROLLBACK VERIFICADO: servicio=%s revision=%s image=%s modo=%s réplicas=%s salud=%s; configuración comparada.\n' "$service" "$(jq -r '.properties.latestRevisionName' "$after")" "$previous_image" "$verified_mode" "$verified_replicas" "$verified_health" >&2
  else
    printf 'ROLLBACK NO VERIFICADO: servicio=%s; revisar ACA manualmente antes de reintentar.\n' "$service" >&2
  fi
  exit 1
fi

normalize_app "$after" > "$work/after-normalized.json"
cmp -s "$work/before-normalized.json" "$work/after-normalized.json" || fail 'la revisión actual no conserva las propiedades/configuración persistentes inspeccionadas'
printf 'Despliegue verificado: servicio=%s revision=%s image=%s health=Healthy.\n' "$service" "$(jq -r '.properties.latestRevisionName' "$after")" "$image"
