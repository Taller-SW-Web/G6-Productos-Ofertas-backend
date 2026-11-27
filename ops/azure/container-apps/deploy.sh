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
chile_explicit_multiple_service() {
  local json="$1" mode
  [[ "$destination" == chile-shared && "$gateway_route_profile" != g5-labelled ]] || return 1
  if [[ "$service" == api-gateway ]]; then return 0; fi
  mode="$(jq -r '.properties.configuration.activeRevisionsMode // empty' "$json")"
  [[ "$service" == price-audit-svc && "$mode" == Multiple ]]
}
verify_chile_scale() {
  local json="$1" min max
  chile_hot_service || return 0
  min="$(jq -r '.properties.template.scale.minReplicas // 0' "$json")"
  max="$(jq -r '.properties.template.scale.maxReplicas // 0' "$json")"
  [[ "$min" == 1 && "$max" == 1 ]] || fail "Chile requiere minReplicas=1 y maxReplicas=1 para $service (actual: min=$min max=$max); no se modificó el escalado"
}
traffic_snapshot() { jq -S -c '.properties.configuration.ingress.traffic // []' "$1"; }
preserved_labels_snapshot() {
  jq -S -c '[.properties.configuration.ingress.traffic[]? | select((.label // "") != "") | {label: .label, revisionName: (.revisionName // ""), weight: (.weight // 0)}] | sort_by(.label, .revisionName)' "$1"
}
preserved_labels_valid() {
  local json="$1"
  if [[ "$service" == api-gateway && "$gateway_route_profile" != g5-labelled ]]; then
    jq -e '
      [.properties.configuration.ingress.traffic[]? | select((.label // "") != "")] as $labelled
      | (all($labelled[]; (.weight // 0) == 0 and ((.revisionName // "") | length > 0) and ((.latestRevision // false) == false) and ((.label // "") | test("^[a-z0-9][a-z0-9-]*$"))))
      and (($labelled | map(.label) | unique | length) == ($labelled | length))
    ' "$json" >/dev/null
  else
    jq -e '[.properties.configuration.ingress.traffic[]? | select((.label // "") != "")] | length == 0' "$json" >/dev/null
  fi
}
traffic_is_revision() {
  local json="$1" expected_revision="$2" expected_labels="${3:-[]}"
  jq -e --arg revision "$expected_revision" --argjson expected_labels "$expected_labels" '
    [.properties.configuration.ingress.traffic[]? | select((.label // "") == "")] as $defaults
    | ([.properties.configuration.ingress.traffic[]? | select((.label // "") != "") | {label: .label, revisionName: (.revisionName // ""), weight: (.weight // 0)}] | sort_by(.label, .revisionName)) as $labelled
    | ($defaults | length) == 1
      and $defaults[0].revisionName == $revision
      and $defaults[0].weight == 100
      and ($defaults[0].latestRevision // false) == false
      and $labelled == ($expected_labels | sort_by(.label, .revisionName))
  ' "$json" >/dev/null
}
set_traffic_revision() {
  local revision="$1" expected_labels="${2:-[]}"
  local -a cmd=(az containerapp ingress traffic set --subscription "$SUBSCRIPTION" --name "$app" --resource-group "$RESOURCE_GROUP" --revision-weight "${revision}=100")
  local -a label_weights=()
  local label
  while IFS= read -r label; do
    [[ -n "$label" ]] && label_weights+=("${label}=0")
  done < <(jq -r '.[].label // empty' <<< "$expected_labels")
  if (( ${#label_weights[@]} > 0 )); then
    cmd+=(--label-weight "${label_weights[@]}")
  fi
  cmd+=(--output none)
  "${cmd[@]}"
}
gateway_modalidad_b_active() {
  local json="$1"
  [[ "$service" == api-gateway ]] || return 1
  jq -e '
    .properties.configuration.ingress.external == true
    and ([.properties.configuration.ingress.ipSecurityRestrictions[]? | select((.action // "") == "Allow")] | length) > 0
  ' "$json" >/dev/null
}
gateway_internal_origin() {
  local json="$1" fqdn
  gateway_modalidad_b_active "$json" || return 0
  fqdn="$(jq -r '.properties.configuration.ingress.fqdn // empty' "$json")"
  if [[ "$fqdn" == api-gateway.* && "$fqdn" != api-gateway.internal.* ]]; then
    printf 'https://api-gateway.internal.%s\n' "${fqdn#api-gateway.}"
  fi
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
  local expected="$1" expected_labels="${2:-[]}" app_json mode latest ready traffic default_routes served_revision served_weight revision_json="$work/served-revision.json" revision_image app_file="$work/served-app.json"
  app_json="$(read_app)" || return 1
  printf '%s\n' "$app_json" > "$app_file"
  mode="$(jq -r '.properties.configuration.activeRevisionsMode // empty' "$app_file")"
  latest="$(jq -r '.properties.latestRevisionName // empty' "$app_file")"
  ready="$(jq -r '.properties.latestReadyRevisionName // empty' "$app_file")"
  traffic="$(jq -c '.properties.configuration.ingress.traffic // []' "$app_file")"
  case "$service:$mode" in
    api-gateway:Multiple|promotions-svc:Single|bulk-svc:Single|bulk-svc:Multiple|catalog-svc:Single|catalog-svc:Multiple|combos-svc:Single|combos-svc:Multiple|inventory-svc:Single|inventory-svc:Multiple|price-audit-svc:Single|price-audit-svc:Multiple|pricing-svc:Single|pricing-svc:Multiple|taxonomy-svc:Single|taxonomy-svc:Multiple) ;;
    *) return 1 ;;
  esac
  [[ -n "$latest" && "$ready" == "$latest" ]] || return 1
  preserved_labels_valid "$app_file" || return 1
  if [[ "$service" == api-gateway ]]; then
    jq -e --argjson expected_labels "$expected_labels" '
      ([.properties.configuration.ingress.traffic[]? | select((.label // "") != "") | {label: .label, revisionName: (.revisionName // ""), weight: (.weight // 0)}] | sort_by(.label, .revisionName)) == ($expected_labels | sort_by(.label, .revisionName))
    ' "$app_file" >/dev/null || return 1
    default_routes="$(jq -c '[.properties.configuration.ingress.traffic[]? | select((.label // "") == "")]' "$app_file")"
  else
    [[ "$(jq 'type == "array" and length == 1' <<< "$traffic")" == true ]] || return 1
    default_routes="$traffic"
  fi
  [[ "$(jq 'type == "array" and length == 1' <<< "$default_routes")" == true ]] || return 1
  if [[ "$service" == price-audit-svc && "$mode" == Multiple ]]; then
    jq -e '.[0].latestRevision != true' <<< "$default_routes" >/dev/null || return 1
  fi
  served_revision="$(jq -r --arg latest "$latest" 'if .[0].latestRevision == true then $latest else (.[0].revisionName // empty) end' <<< "$default_routes")"
  served_weight="$(jq -r '.[0].weight // 0' <<< "$default_routes")"
  [[ -n "$served_revision" && "$served_revision" == "$latest" && "$served_weight" == 100 ]] || return 1
  revision_health "$served_revision" "$revision_json" || return 1
  revision_image="$(container_image "$revision_json" 2>/dev/null || true)"
  [[ "$revision_image" == "$expected" ]] || return 1
  verified_served_revision="$served_revision"
  verified_served_digest="${expected##*@}"
  verified_served_health="$(jq -r '.properties.healthState // empty' "$revision_json")"
  verified_preserved_labels="$(preserved_labels_snapshot "$app_file")"
}

verify_chile_gateway_current_traffic() {
  local expected="$1" expected_labels="${2:-}" app_json default_routes served_revision weight revision_json="$work/current-traffic-revision.json" app_file="$work/current-traffic-app.json" revision_image active health running replicas provisioning min max
  app_json="$(read_app)" || return 1
  printf '%s\n' "$app_json" > "$app_file"
  [[ "$(jq -r '.properties.configuration.activeRevisionsMode // empty' "$app_file")" == Multiple ]] || return 1
  preserved_labels_valid "$app_file" || return 1
  if [[ -n "$expected_labels" ]]; then
    jq -e --argjson expected_labels "$expected_labels" '
      ([.properties.configuration.ingress.traffic[]? | select((.label // "") != "") | {label: .label, revisionName: (.revisionName // ""), weight: (.weight // 0)}] | sort_by(.label, .revisionName)) == ($expected_labels | sort_by(.label, .revisionName))
    ' "$app_file" >/dev/null || return 1
  fi
  default_routes="$(jq -c '[.properties.configuration.ingress.traffic[]? | select((.label // "") == "")]' "$app_file")"
  [[ "$(jq 'type == "array" and length == 1' <<< "$default_routes")" == true ]] || return 1
  if [[ "$service" == price-audit-svc ]]; then
    jq -e '.[0].latestRevision != true' <<< "$default_routes" >/dev/null || return 1
  fi
  served_revision="$(jq -r --arg latest "$(jq -r '.properties.latestRevisionName // empty' "$app_file")" 'if .[0].latestRevision == true then $latest else (.[0].revisionName // empty) end' <<< "$default_routes")"
  weight="$(jq -r '.[0].weight // 0' <<< "$default_routes")"
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
  if [[ "$service" == api-gateway ]]; then
    [[ "$min" == 1 && "$max" == 1 ]] || { printf 'Gateway traffic check: revision=%s scale=%s/%s expected=1/1\n' "$served_revision" "$min" "$max" >&2; return 1; }
  fi
  [[ "$revision_image" == "$expected" && "$active" == true && "$health" == Healthy && ( "$running" == Running || "$running" == RunningAtMaxScale ) && "$replicas" =~ ^[1-9][0-9]*$ && "$provisioning" == Provisioned ]] || { printf '%s traffic check: revision=%s image=%s active=%s health=%s running=%s replicas=%s provisioning=%s scale=%s/%s expected=%s\n' "$service" "$served_revision" "$revision_image" "$active" "$health" "$running" "$replicas" "$provisioning" "$min" "$max" "$expected" >&2; return 1; }
  verified_served_revision="$served_revision"
  verified_served_digest="${expected##*@}"
  verified_served_health="$health"
  verified_preserved_labels="$(preserved_labels_snapshot "$app_file")"
}

verify_specific_revision_healthy() {
  local target_rev="$1" expected_image="$2" revision_json="$work/specific-revision.json" revision_image active health running replicas provisioning
  [[ -n "$target_rev" ]] || return 1
  revision_health "$target_rev" "$revision_json" || return 1
  revision_image="$(container_image "$revision_json" 2>/dev/null || true)"
  active="$(jq -r '.properties.active // false' "$revision_json")"
  health="$(jq -r '.properties.healthState // empty' "$revision_json")"
  running="$(jq -r '.properties.runningState // empty' "$revision_json")"
  replicas="$(jq -r '.properties.replicas // 0' "$revision_json")"
  provisioning="$(jq -r '.properties.provisioningState // empty' "$revision_json")"
  [[ "$revision_image" == "$expected_image" && "$active" == true && "$health" == Healthy && ( "$running" == Running || "$running" == RunningAtMaxScale ) && "$replicas" =~ ^[1-9][0-9]*$ && "$provisioning" == Provisioned ]]
}

# Active revisions can consume R16 even when they receive zero HTTP traffic.
price_audit_consumers() {
  local names name revision_json="$work/r16-revision.json"
  names="$(az containerapp revision list --subscription "$SUBSCRIPTION" --name "$app" --resource-group "$RESOURCE_GROUP" --output json |
    jq -er 'if type != "array" then error("revisiones ACA inválidas") else [.[] | select(.properties.active == true) | .name] | sort | .[] end')" || return 1
  while IFS= read -r name; do
    [[ -n "$name" ]] || return 1
    revision_health "$name" "$revision_json" || return 1
    jq -e '.properties.active == true and ([.properties.template.containers[] | select(.name == "price-audit-svc")] | length == 1)' "$revision_json" >/dev/null || return 1
    if price_audit_has_service_bus "$revision_json"; then printf '%s\n' "$name"; fi
  done <<< "$names"
}

price_audit_has_service_bus() {
  jq -e 'any(.properties.template.containers[] | select(.name == "price-audit-svc") | .env[]?; .name == "MESSAGING_PROVIDER" and .value == "AZURE_SERVICE_BUS")' "$1" >/dev/null
}

price_audit_revision_state() {
  local action="$1" name="$2" expected_image="$3" state="$work/r16-state.json" attempt
  [[ -n "$name" ]] || return 1
  revision_health "$name" "$state" || return 1
  [[ "$(container_image "$state")" == "$expected_image" ]] && price_audit_has_service_bus "$state" || return 1
  if [[ "$action" == activate ]]; then
    if jq -e '.properties.active == false' "$state" >/dev/null; then
      az containerapp revision activate --subscription "$SUBSCRIPTION" --name "$app" --resource-group "$RESOURCE_GROUP" --revision "$name" --output none || return 1
    fi
    for ((attempt=0; attempt<${ACA_POLL_ATTEMPTS:-30}; attempt++)); do
      verify_specific_revision_healthy "$name" "$expected_image" && return 0
      sleep "${ACA_POLL_INTERVAL_SECONDS:-10}"
    done
  else
    if jq -e '.properties.active == true' "$state" >/dev/null; then
      az containerapp revision deactivate --subscription "$SUBSCRIPTION" --name "$app" --resource-group "$RESOURCE_GROUP" --revision "$name" --output none || return 1
    fi
    for ((attempt=0; attempt<${ACA_POLL_ATTEMPTS:-30}; attempt++)); do
      if revision_health "$name" "$state" && jq -e '.properties.active == false and .properties.replicas == 0' "$state" >/dev/null; then return 0; fi
      sleep "${ACA_POLL_INTERVAL_SECONDS:-10}"
    done
  fi
  return 1
}

restore_price_audit_revision() {
  local previous_revision="$1" current_image="$2" candidate_revision restored_template consumer consumers
  [[ -n "$previous_revision" ]] || fail 'RECUPERACIÓN OMITIDA: recibo de Price Audit sin revisión anterior'
  if [[ "$current_image" == "$image" && "$image" != "$previous_image" ]]; then
    candidate_revision="$(jq -er '.properties.latestRevisionName | select(type == "string" and length > 0)' "$after")" ||
      fail 'RECUPERACIÓN OMITIDA: sin revisión candidata identificable'
    [[ "$candidate_revision" != "$previous_revision" ]] || fail 'RECUPERACIÓN OMITIDA: revisión candidata coincide con la anterior'
    if ! traffic_is_revision "$after" "$previous_revision" && ! traffic_is_revision "$after" "$candidate_revision"; then
      fail 'RECUPERACIÓN OMITIDA: tráfico de Price Audit cambió concurrentemente'
    fi
    consumers="$(price_audit_consumers)" || fail 'RECUPERACIÓN OMITIDA: no se pudieron identificar consumidores R16'
    while IFS= read -r consumer; do
      [[ -z "$consumer" || "$consumer" == "$previous_revision" || "$consumer" == "$candidate_revision" ]] ||
        fail "RECUPERACIÓN OMITIDA: consumidor R16 inesperado: $consumer"
    done <<< "$consumers"
    price_audit_revision_state activate "$previous_revision" "$previous_image" ||
      fail 'RECUPERACIÓN INCOMPLETA: no se verificó la reactivación sana de la revisión anterior'
    local recheck="$work/r16-recheck.json"
    if ! read_app > "$recheck" || ! normalize_app "$recheck" > "$work/r16-before-traffic.json" ||
       ! cmp -s "$work/current-normalized.json" "$work/r16-before-traffic.json" ||
       [[ "$(container_image "$recheck")" != "$image" || "$(traffic_snapshot "$recheck")" != "$(traffic_snapshot "$after")" ]]; then
      fail 'RECUPERACIÓN OMITIDA: Price Audit cambió al reactivar la revisión anterior'
    fi
    if traffic_is_revision "$recheck" "$candidate_revision"; then
      set_traffic_revision "$previous_revision" || fail 'RECUPERACIÓN INCOMPLETA: no se pudo fijar el tráfico anterior'
    fi
    if ! verify_chile_gateway_current_traffic "$previous_image" || [[ "$verified_served_revision" != "$previous_revision" ]]; then
      fail 'RECUPERACIÓN INCOMPLETA: la revisión anterior no sirve el digest previo'
    fi
    price_audit_revision_state deactivate "$candidate_revision" "$image" ||
      fail 'RECUPERACIÓN INCOMPLETA: el candidato todavía puede consumir R16'
    [[ "$(price_audit_consumers)" == "$previous_revision" ]] ||
      fail 'RECUPERACIÓN INCOMPLETA: el consumidor R16 anterior no es único'
    if ! read_app > "$recheck" || ! normalize_app "$recheck" > "$work/r16-before-template.json" ||
       ! cmp -s "$work/current-normalized.json" "$work/r16-before-template.json" ||
       ! traffic_is_revision "$recheck" "$previous_revision" ||
       [[ "$(container_image "$recheck")" != "$image" || "$(jq -r '.properties.latestRevisionName' "$recheck")" != "$candidate_revision" ]]; then
      fail 'RECUPERACIÓN OMITIDA: Price Audit cambió antes de restaurar la plantilla'
    fi
    az containerapp update --subscription "$SUBSCRIPTION" --name "$app" --resource-group "$RESOURCE_GROUP" --container-name "$container" --image "$previous_image" --output none ||
      fail 'RECUPERACIÓN INCOMPLETA: Azure rechazó restaurar el digest de la plantilla'
  fi
  if ! read_app > "$after" || ! normalize_app "$after" > "$work/r16-restored.json" ||
     ! cmp -s "$work/current-normalized.json" "$work/r16-restored.json" ||
     [[ "$(container_image "$after")" != "$previous_image" ]] || ! traffic_is_revision "$after" "$previous_revision"; then
    fail 'RECUPERACIÓN INCOMPLETA: plantilla, tráfico o configuración de Price Audit no coinciden'
  fi
  restored_template="$(jq -er '.properties.latestRevisionName | select(type == "string" and length > 0)' "$after")" ||
    fail 'RECUPERACIÓN INCOMPLETA: no se pudo identificar la plantilla restaurada'
  if [[ "$restored_template" != "$previous_revision" ]]; then
    price_audit_revision_state deactivate "$restored_template" "$previous_image" ||
      fail 'RECUPERACIÓN INCOMPLETA: la revisión creada al restaurar la plantilla todavía puede consumir R16'
  fi
  if [[ "$(price_audit_consumers)" != "$previous_revision" ]] ||
     ! verify_chile_gateway_current_traffic "$previous_image" || [[ "$verified_served_revision" != "$previous_revision" ]]; then
    fail 'RECUPERACIÓN INCOMPLETA: no se verificó el consumidor único y la ruta anterior de Price Audit'
  fi
  printf 'ROLLBACK COORDINADO VERIFICADO: servicio=%s revision=%s image=%s consumidor_r16=%s.\n' "$service" "$previous_revision" "$previous_image" "$previous_revision"
}

recover_chile_gateway_template() {
  local current_image
  verify_chile_gateway_current_traffic "$previous_image" "$previous_preserved_labels" || fail "RECUPERACIÓN OMITIDA: revisión anterior de $service no sigue saludable y servida"
  read_app > "$after" || fail "RECUPERACIÓN OMITIDA: no se pudo releer $service antes de restaurar la plantilla"
  normalize_app "$after" > "$work/pre-template-recovery-normalized.json"
  cmp -s "$work/before-normalized.json" "$work/pre-template-recovery-normalized.json" || fail 'RECUPERACIÓN OMITIDA: configuración cambió antes de restaurar la plantilla'
  current_image="$(container_image "$after")"
  [[ "$current_image" == "$image" ]] || fail 'RECUPERACIÓN OMITIDA: digest de plantilla cambió concurrentemente'
  traffic_is_revision "$after" "$previous_served_revision" "$previous_preserved_labels" || fail 'RECUPERACIÓN OMITIDA: tráfico cambió antes de restaurar la plantilla'
  az containerapp update --subscription "$SUBSCRIPTION" --name "$app" --resource-group "$RESOURCE_GROUP" --container-name "$container" --image "$previous_image" --output none || fail 'RECUPERACIÓN INCOMPLETA: Azure rechazó restaurar el digest anterior en la plantilla; ruta anterior permanece servida'
  verify_revision "$previous_image" || fail "RECUPERACIÓN INCOMPLETA: plantilla anterior aplicada pero revisión latest no Healthy: $revision_verify_detail"
  read_app > "$after" || fail 'RECUPERACIÓN INCOMPLETA: no se pudo verificar la plantilla restaurada'
  normalize_app "$after" > "$work/post-template-recovery-normalized.json"
  cmp -s "$work/before-normalized.json" "$work/post-template-recovery-normalized.json" || fail 'RECUPERACIÓN INCOMPLETA: configuración cambió durante la restauración de plantilla'
  [[ "$(container_image "$after")" == "$previous_image" ]] || fail 'RECUPERACIÓN INCOMPLETA: plantilla no conserva el digest anterior'
  traffic_is_revision "$after" "$previous_served_revision" "$previous_preserved_labels" || fail 'RECUPERACIÓN INCOMPLETA: tráfico cambió durante la restauración de plantilla'
  verify_chile_gateway_current_traffic "$previous_image" "$previous_preserved_labels" || fail 'RECUPERACIÓN INCOMPLETA: la ruta anterior perdió salud o etiquetas preservadas'
  printf 'PLANTILLA RECUPERADA: %s sirve revisión anterior %s; siguiente despliegue puede reintentarse.\n' "$service" "$previous_served_revision" >&2
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
  explicit_multiple=false
  if chile_explicit_multiple_service "$before"; then explicit_multiple=true; fi
  restore_preserved_labels='[]'
  if [[ "$explicit_multiple" == true ]]; then
    if [[ -n "${H5_PRESERVED_LABELS:-}" ]]; then
      restore_preserved_labels="$(jq -S -c 'sort_by(.label, .revisionName)' <<< "$H5_PRESERVED_LABELS")" || fail 'etiquetas preservadas inválidas en el recibo'
    else
      restore_preserved_labels="$(preserved_labels_snapshot "$before")"
    fi
  fi
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
  elif [[ "$destination" == chile-shared && "$current" == "$previous_image" && "$explicit_multiple" != true ]]; then
    verify_chile_served_revision "$previous_image" || fail 'RECUPERACIÓN NO VERIFICADA: el digest anterior no recibe el 100% del tráfico Chile'
  fi
  if [[ "$explicit_multiple" == true && "$service" != price-audit-svc && "$current" != "$previous_image" ]]; then
    verify_chile_served_revision "$current" "$restore_preserved_labels" || fail "RECUPERACIÓN OMITIDA: $service no sirve de forma exclusiva la revisión aplicada ni conserva etiquetas preservadas"
    restore_served_revision="$verified_served_revision"
    restore_traffic="$(traffic_snapshot "$before")"
  fi
  normalize_app "$before" > "$work/current-normalized.json"
  current_hash="$(sha256sum "$work/current-normalized.json" | awk '{print $1}')"
  [[ "$current_hash" == "$expected_config_hash" && ( "$current" == "$image" || "$current" == "$previous_image" ) ]] ||
    fail "RECUPERACIÓN OMITIDA: $service cambió concurrentemente (imagen/configuración)"
  if [[ "$explicit_multiple" == true && "$service" == price-audit-svc ]]; then
    cp "$before" "$after"
    restore_price_audit_revision "${H5_PREVIOUS_SERVED_REVISION:-}" "$current"
    exit 0
  fi
  if [[ "$current" == "$previous_image" ]]; then
    if [[ "$explicit_multiple" == true ]]; then
      verify_chile_gateway_current_traffic "$previous_image" "$restore_preserved_labels" || fail 'RECUPERACIÓN NO VERIFICADA: Gateway no sirve al 100% una revisión saludable con el digest anterior ni conserva etiquetas'
    fi
    printf 'RECUPERACIÓN YA PRESENTE: servicio=%s conserva digest anterior y configuración.\n' "$service"
    exit 0
  fi
  if [[ "$gateway_route_profile" == g5-labelled ]]; then
    restore_g5_gateway_revision "$previous_image" "$image" "$marketplace_revision" || fail 'RECUPERACIÓN NO VERIFICADA: Gateway conserva su URL Marketplace y el rollback del label G5 no pudo acreditarse'
    normalize_app "$after" > "$work/after-normalized.json"
    cmp -s "$work/current-normalized.json" "$work/after-normalized.json" || fail 'la configuración cambió durante la recuperación de Gateway etiquetado'
    printf 'ROLLBACK COORDINADO VERIFICADO: servicio=%s revision=%s image=%s Marketplace_revision=%s.\n' "$service" "$(jq -r '.properties.latestRevisionName' "$after")" "$previous_image" "$marketplace_revision"
    exit 0
  fi
  if [[ "$explicit_multiple" == true ]]; then
    read_app > "$after" || fail "no se pudo releer $service antes de recuperación"
    normalize_app "$after" > "$work/restore-pre-pin-normalized.json"
    cmp -s "$work/current-normalized.json" "$work/restore-pre-pin-normalized.json" || fail 'RECUPERACIÓN OMITIDA: configuración cambió antes de fijar tráfico'
    [[ "$(traffic_snapshot "$after")" == "$restore_traffic" ]] || fail 'RECUPERACIÓN OMITIDA: tráfico cambió concurrentemente antes del pinning'
    set_traffic_revision "$restore_served_revision" "$restore_preserved_labels" || fail "no se pudo fijar revisión actual antes de la recuperación de $service"
    read_app > "$after" || fail "no se pudo releer $service tras fijar tráfico de recuperación"
    traffic_is_revision "$after" "$restore_served_revision" "$restore_preserved_labels" || fail 'RECUPERACIÓN OMITIDA: el tráfico o etiquetas preservadas cambiaron durante el pinning'
    normalize_app "$after" > "$work/restore-pinned-normalized.json"
    cmp -s "$work/current-normalized.json" "$work/restore-pinned-normalized.json" || fail 'RECUPERACIÓN OMITIDA: configuración cambió durante el pinning'
  fi
  az containerapp update --subscription "$SUBSCRIPTION" --name "$app" --resource-group "$RESOURCE_GROUP" --container-name "$container" --image "$previous_image" --output none || fail 'Azure rechazó la recuperación'
  verify_revision "$previous_image" || fail 'revisión de recuperación no Healthy'
  if [[ "$destination" == chile-shared ]]; then
    if [[ "$explicit_multiple" == true ]]; then
      read_app > "$after" || fail "no se pudo comprobar el tráfico durante recuperación de $service"
      normalize_app "$after" > "$work/restore-normalized.json"
      cmp -s "$work/current-normalized.json" "$work/restore-normalized.json" || fail 'RECUPERACIÓN OMITIDA: configuración cambió concurrentemente'
      traffic_is_revision "$after" "$restore_served_revision" "$restore_preserved_labels" || fail 'RECUPERACIÓN OMITIDA: tráfico o etiquetas cambiaron concurrentemente'
      restore_candidate_revision="$(jq -r '.properties.latestRevisionName' "$after")"
      set_traffic_revision "$restore_candidate_revision" "$restore_preserved_labels" || fail "Azure rechazó recuperar el tráfico de $service"
    fi
    verify_chile_served_revision "$previous_image" "$restore_preserved_labels" || fail 'RECUPERACIÓN NO VERIFICADA: el digest anterior no recibe el 100% del tráfico Chile ni conserva etiquetas'
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
explicit_multiple=false
if chile_explicit_multiple_service "$before"; then explicit_multiple=true; fi
previous_preserved_labels='[]'
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
  if [[ "$explicit_multiple" == true ]]; then
    verify_chile_gateway_current_traffic "$previous_image" || fail "tráfico Chile previo de $service no es una revisión única, sana y verificable; no se modifica Azure"
    previous_preserved_labels="$verified_preserved_labels"
  else
    verify_chile_served_revision "$previous_image" || fail 'tráfico Chile previo es ambiguo/incompatible con un despliegue individual; no se modifica Azure'
  fi
  previous_served_revision="$verified_served_revision"
  previous_traffic="$(traffic_snapshot "$before")"
  if [[ "$explicit_multiple" == true && "$service" == price-audit-svc ]]; then
    [[ "$(price_audit_consumers)" == "$previous_served_revision" ]] ||
      fail 'preflight R16 exige que solo la revisión previa consuma Service Bus'
  fi
fi
normalize_app "$before" > "$work/before-normalized.json"
baseline_hash="$(sha256sum "$work/before-normalized.json" | awk '{print $1}')"
modalidad_b=false
internal_origin=''
if gateway_modalidad_b_active "$before"; then
  modalidad_b=true
  internal_origin="$(gateway_internal_origin "$before")"
fi
if [[ -n "${DEPLOY_RECEIPT:-}" ]]; then
  origin=''
  if [[ "$destination" == chile-shared ]]; then origin="$(get_chile_origin)"; fi
  jq -n \
    --arg service "$service" \
    --arg destination "$DESTINATION" \
    --arg environment "$DEPLOYMENT_ENVIRONMENT" \
    --arg run_id "${GITHUB_RUN_ID:-}" \
    --arg resource_group "$RESOURCE_GROUP" \
    --arg aca_environment "$ACA_ENVIRONMENT" \
    --arg location "$REGION" \
    --arg subscription "$SUBSCRIPTION" \
    --arg app_id "$(jq -r '.id' "$before")" \
    --arg container "$container" \
    --arg previous "$previous_image" \
    --arg target "$image" \
    --arg config "$baseline_hash" \
    --arg origin "$origin" \
    --arg internal_origin "$internal_origin" \
    --argjson modalidad_b "$modalidad_b" \
    --argjson preserved_labels "$previous_preserved_labels" \
    --arg route_profile "$gateway_route_profile" \
    --arg previous_served_revision "${previous_served_revision:-}" \
    '{
      service:$service,
      destination:$destination,
      github_environment:$environment,
      workflow_run_id:$run_id,
      resource_group:$resource_group,
      aca_environment:$aca_environment,
      location:$location,
      subscription_id:$subscription,
      app_resource_id:$app_id,
      container:$container,
      previous:$previous,
      target:$target,
      digest_candidate:($target | split("@")[1]),
      origin_https:(if $origin == "" then null else $origin end),
      internal_origin_https:(if $internal_origin == "" then null else $internal_origin end),
      modalidad_b:$modalidad_b,
      preserved_labels:$preserved_labels,
      previous_served_revision:(if $previous_served_revision == "" then null else $previous_served_revision end),
      config_sha256:$config,
      route_profile:$route_profile,
      marketplace_revision:(if $route_profile == "g5-labelled" then $previous_served_revision else null end)
    }' > "$DEPLOY_RECEIPT"
fi

if [[ "$previous_image" == "$image" ]]; then
  printf 'Idempotencia: %s ya usa la imagen/digest solicitado; verificando revisión existente.\n' "$service"
  verify_revision "$image" || fail 'imagen ya presente, pero revisión activa no está Healthy'
  if [[ "$destination" == chile-shared ]]; then
    if [[ "$gateway_route_profile" == g5-labelled ]]; then
      verify_g5_gateway_revision "$image" "$previous_served_revision" true || fail 'revisión/label G5 no coincide con tráfico Marketplace intacto'
      [[ -n "${DEPLOY_RECEIPT:-}" ]] && jq --arg revision "$verified_served_revision" --arg digest "$verified_served_digest" --arg url "$verified_label_url" '.served_revision=$revision | .served_digest=$digest | .served_health="Healthy" | .route_mode="revision_label" | .g5_label="g5-h5" | .g5_label_url=$url | .marketplace_traffic_weight=100' "$DEPLOY_RECEIPT" > "$DEPLOY_RECEIPT.tmp" && mv "$DEPLOY_RECEIPT.tmp" "$DEPLOY_RECEIPT"
    else
      verify_chile_served_revision "$image" "$previous_preserved_labels" || fail 'tráfico efectivo Chile no apunta exclusivamente a la revisión latest con digest candidato ni conserva etiquetas'
      [[ -n "${DEPLOY_RECEIPT:-}" ]] && jq --arg revision "$verified_served_revision" --arg digest "$verified_served_digest" --arg health "${verified_served_health:-Healthy}" --argjson labels "$verified_preserved_labels" --argjson explicit "$explicit_multiple" '.served_revision=$revision | .served_digest=$digest | .served_health=$health | .preserved_labels=$labels | .traffic_weight=100 | if .service == "price-audit-svc" and $explicit then .r16_consumer_revision=$revision else . end' "$DEPLOY_RECEIPT" > "$DEPLOY_RECEIPT.tmp" && mv "$DEPLOY_RECEIPT.tmp" "$DEPLOY_RECEIPT"
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
    if [[ "$explicit_multiple" == true ]]; then
      # Freeze Multiple-mode traffic on the known-good revision (and preserved 0% labels) before ACA creates a candidate.
      read_app > "$after" || fail "no se pudo releer $service antes del pinning preventivo"
      normalize_app "$after" > "$work/pre-pin-normalized.json"
      cmp -s "$work/before-normalized.json" "$work/pre-pin-normalized.json" || fail "cambió configuración de $service antes del pinning; actualización cancelada"
      [[ "$(traffic_snapshot "$after")" == "$previous_traffic" ]] || fail "cambió concurrentemente el tráfico previo de $service; actualización cancelada"
      if ! set_traffic_revision "$previous_served_revision" "$previous_preserved_labels"; then
        fail "no se pudo fijar el tráfico previo de $service; actualización cancelada"
      fi
      read_app > "$after" || fail "no se pudo releer $service tras fijar tráfico previo"
      normalize_app "$after" > "$work/pinned-normalized.json"
      cmp -s "$work/before-normalized.json" "$work/pinned-normalized.json" || fail "cambió configuración durante el pinning preventivo de $service"
      traffic_is_revision "$after" "$previous_served_revision" "$previous_preserved_labels" || fail "cambió concurrentemente el tráfico previo o las etiquetas preservadas de $service; actualización cancelada"
    fi
    if ! az containerapp update --subscription "$SUBSCRIPTION" --name "$app" --resource-group "$RESOURCE_GROUP" --container-name "$container" --image "$image" --output none; then
      failure_stage='az containerapp update rechazó el cambio de imagen'
    elif ! verify_revision "$image"; then
      failure_stage="verificación latest/ready/health/running: $revision_verify_detail"
    elif [[ "$destination" == chile-shared && "$explicit_multiple" != true ]] && ! verify_chile_served_revision "$image"; then
      failure_stage='revisión sana pero el modo ACA/traffic no asigna 100% a latestRevision'
    elif ! normalize_app "$after" > "$work/after-normalized.json"; then
      failure_stage='no se pudo normalizar la configuración ACA posterior al cambio'
    elif ! cmp -s "$work/before-normalized.json" "$work/after-normalized.json"; then
      failure_stage='drift de configuración persistente entre baseline y readback'
    elif [[ "$explicit_multiple" == true ]] && ! verify_revision "$image"; then
      failure_stage="la revisión candidata de $service perdió salud antes del corte"
    elif [[ "$explicit_multiple" == true ]] && { ! read_app > "$after" || ! traffic_is_revision "$after" "$previous_served_revision" "$previous_preserved_labels" || ! normalize_app "$after" > "$work/pre-cutover-normalized.json" || ! cmp -s "$work/before-normalized.json" "$work/pre-cutover-normalized.json"; }; then
      failure_stage="cambio concurrente o tráfico/etiquetas inesperados antes del corte de $service"
    elif [[ "$explicit_multiple" == true ]] && ! set_traffic_revision "$(jq -r '.properties.latestRevisionName' "$after")" "$previous_preserved_labels"; then
      failure_stage="Azure rechazó el corte controlado de tráfico de $service"
    elif [[ "$destination" == chile-shared ]] && ! verify_chile_served_revision "$image" "$previous_preserved_labels"; then
      failure_stage='tráfico efectivo Chile no apunta exclusivamente a la revisión sana con digest candidato ni conserva etiquetas'
    elif [[ "$explicit_multiple" == true ]] && ! verify_revision "$image"; then
      failure_stage="revisión servida de $service perdió salud tras el corte: $revision_verify_detail"
    elif [[ "$explicit_multiple" == true ]] && { ! read_app > "$after" || ! normalize_app "$after" > "$work/after-cutover-normalized.json"; }; then
      failure_stage="no se pudo verificar configuración posterior al corte de $service"
    elif [[ "$explicit_multiple" == true ]] && ! cmp -s "$work/before-normalized.json" "$work/after-cutover-normalized.json"; then
      failure_stage="cambió configuración durante el corte de tráfico de $service"
    elif [[ "$destination" == chile-shared ]] && ! verify_chile_served_revision "$image" "$previous_preserved_labels"; then
      failure_stage='el tráfico Chile o las etiquetas preservadas cambiaron durante la verificación final'
    fi
  fi
  if [[ -z "$failure_stage" && "$explicit_multiple" == true && "$service" == price-audit-svc ]]; then
    if ! price_audit_revision_state deactivate "$previous_served_revision" "$previous_image" ||
       [[ "$(price_audit_consumers)" != "$verified_served_revision" ]]; then
      failure_stage='R16 no quedó con un único consumidor en la revisión candidata'
    fi
  fi
  if [[ -z "$failure_stage" ]]; then
    if [[ "$destination" == chile-shared && -n "${DEPLOY_RECEIPT:-}" ]]; then
      if [[ "$gateway_route_profile" == g5-labelled ]]; then
        jq --arg revision "$verified_served_revision" --arg digest "$verified_served_digest" --arg url "$verified_label_url" '.served_revision=$revision | .served_digest=$digest | .served_health="Healthy" | .route_mode="revision_label" | .g5_label="g5-h5" | .g5_label_url=$url | .marketplace_traffic_weight=100' "$DEPLOY_RECEIPT" > "$DEPLOY_RECEIPT.tmp" && mv "$DEPLOY_RECEIPT.tmp" "$DEPLOY_RECEIPT"
      else
        jq --arg revision "$verified_served_revision" --arg digest "$verified_served_digest" --arg health "${verified_served_health:-Healthy}" --argjson labels "$verified_preserved_labels" --argjson explicit "$explicit_multiple" '.served_revision=$revision | .served_digest=$digest | .served_health=$health | .preserved_labels=$labels | .traffic_weight=100 | if .service == "price-audit-svc" and $explicit then .r16_consumer_revision=$revision else . end' "$DEPLOY_RECEIPT" > "$DEPLOY_RECEIPT.tmp" && mv "$DEPLOY_RECEIPT.tmp" "$DEPLOY_RECEIPT"
      fi
    fi
    printf 'Despliegue verificado: servicio=%s revision=%s image=%s modo=%s réplicas=%s salud=%s.\n' "$service" "$(jq -r '.properties.latestRevisionName' "$after")" "$image" "$verified_mode" "$verified_replicas" "$verified_health"
    exit 0
  fi

  printf 'Fallo tras actualización de %s; etapa=%s.\n' "$service" "$failure_stage" >&2
  read_app > "$after" || fail 'ROLLBACK NO VERIFICADO: no se pudo releer ACA; revisar manualmente'
  if [[ "$explicit_multiple" == true ]]; then
    normalize_app "$after" > "$work/failure-normalized.json" || fail 'RECUPERACIÓN NO VERIFICADA: no se pudo comparar configuración'
    cmp -s "$work/before-normalized.json" "$work/failure-normalized.json" || fail 'RECUPERACIÓN OMITIDA: configuración cambió concurrentemente'
    current="$(container_image "$after" 2>/dev/null || true)"
    if [[ "$current" == "$previous_image" ]]; then
      traffic_is_revision "$after" "$previous_served_revision" "$previous_preserved_labels" || fail 'RECUPERACIÓN OMITIDA: tráfico cambió concurrentemente; no se sobrescribe'
      verify_chile_gateway_current_traffic "$previous_image" "$previous_preserved_labels" || fail 'RECUPERACIÓN NO VERIFICADA: revisión anterior perdió salud o etiquetas preservadas'
      if [[ "$service" == price-audit-svc ]]; then
        [[ "$(price_audit_consumers)" == "$previous_served_revision" ]] ||
          fail 'RECUPERACIÓN INCOMPLETA: la revisión anterior no es el único consumidor de R16'
      fi
      printf 'ACTUALIZACIÓN NO APLICADA: %s conserva digest, configuración y ruta previos.\n' "$service" >&2
      exit 1
    fi
    [[ "$current" == "$image" ]] || fail 'RECUPERACIÓN OMITIDA: digest de plantilla cambió concurrentemente'
    if [[ "$service" == price-audit-svc ]]; then
      cp "$work/before-normalized.json" "$work/current-normalized.json"
      restore_price_audit_revision "$previous_served_revision" "$current"
      exit 1
    fi
    candidate_revision="$(jq -r '.properties.latestRevisionName' "$after")"
    if traffic_is_revision "$after" "$candidate_revision" "$previous_preserved_labels"; then
      set_traffic_revision "$previous_served_revision" "$previous_preserved_labels" || fail 'RECUPERACIÓN NO VERIFICADA: no se pudo restaurar el tráfico a la revisión anterior'
      read_app > "$after" || fail 'RECUPERACIÓN NO VERIFICADA: no se pudo releer el tráfico restaurado'
      traffic_is_revision "$after" "$previous_served_revision" "$previous_preserved_labels" || fail 'RECUPERACIÓN NO VERIFICADA: tráfico posterior no coincide con la revisión anterior ni con las etiquetas preservadas'
      normalize_app "$after" > "$work/recovered-normalized.json"
      cmp -s "$work/before-normalized.json" "$work/recovered-normalized.json" || fail 'RECUPERACIÓN NO VERIFICADA: configuración cambió durante recuperación'
      recover_chile_gateway_template
      exit 1
    fi
    traffic_is_revision "$after" "$previous_served_revision" "$previous_preserved_labels" || fail 'RECUPERACIÓN OMITIDA: tráfico cambió concurrentemente; no se sobrescribe'
    printf 'TRÁFICO PREVIO CONSERVADO: %s mantiene revisión %s.\n' "$service" "$previous_served_revision" >&2
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
