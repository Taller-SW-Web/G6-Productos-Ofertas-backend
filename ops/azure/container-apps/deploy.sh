#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly REPOSITORY='ghcr.io/taller-sw-web/g6-productos-ofertas-backend'
fail() { printf 'Despliegue Azure fallido: %s\n' "$1" >&2; exit 1; }

TARGETS="$(dirname "$0")/deployment-targets.json"
destination="${H5_DEPLOY_DESTINATION:-brazil-isolated}"
environment="${H5_DEPLOY_ENVIRONMENT:-}"
pilot="${H5_PILOT_SELF_REVIEW:-false}"
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
  jq -S -c --arg target "$container" --arg destination "$destination" '
    {
      identity: .identity,
      location: .location,
      tags: .tags,
      kind: .kind,
      properties: (
        .properties
        | del(.latestRevisionName, .latestReadyRevisionName, .latestRevisionFqdn, .provisioningState)
        | if $destination == "chile-shared" then del(.configuration.ingress.traffic) else . end
        | .template |= (del(.revisionSuffix) | .containers |= map(if .name == $target then del(.image) else . end))
      )
    }' "$1"
}
container_image() { jq -er --arg name "$container" '[.properties.template.containers[] | select(.name == $name) | .image] | if length == 1 then .[0] else error("container target ausente o duplicado") end' "$1"; }
revision_health() { az containerapp revision show --subscription "$SUBSCRIPTION" --name "$app" --resource-group "$RESOURCE_GROUP" --revision "$1" --output json > "$2"; }
revision_verify_detail='no se obtuvo estado de revisión'
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
      if [[ "$revision_image" == "$expected" && "$active" == true && "$running" == Running && "$replicas" =~ ^[1-9][0-9]*$ && "$health" == Healthy && "$provisioning" == Provisioned ]]; then
        verified_mode=running; verified_replicas="$replicas"; verified_health="$health"
        return 0
      fi
      if [[ "$revision_image" == "$expected" && "$active" == true && ( "$running" == Stopped || "$running" == ScaledToZero ) && "$replicas" == 0 && "$min_replicas" == 0 && "$provisioning" == Provisioned && ( "$health" == None || "$health" == Healthy ) ]]; then
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
  current="$(container_image "$before")" || fail 'no se pudo verificar imagen actual'
  if [[ "$destination" == chile-shared && "$current" == "$previous_image" ]]; then
    verify_chile_served_revision "$previous_image" || fail 'RECUPERACIÓN NO VERIFICADA: el digest anterior no recibe el 100% del tráfico Chile'
  fi
  normalize_app "$before" > "$work/current-normalized.json"
  current_hash="$(sha256sum "$work/current-normalized.json" | awk '{print $1}')"
  if [[ "$current" == "$previous_image" && "$current_hash" == "$expected_config_hash" ]]; then
    printf 'RECUPERACIÓN YA PRESENTE: servicio=%s conserva digest anterior y configuración.\n' "$service"
    exit 0
  fi
  [[ "$current" == "$image" && "$current_hash" == "$expected_config_hash" ]] || {
    printf 'RECUPERACIÓN OMITIDA: %s cambió concurrentemente (imagen/configuración); no se sobrescribe. Revisión manual requerida.\n' "$service" >&2
    exit 1
  }
  az containerapp update --subscription "$SUBSCRIPTION" --name "$app" --resource-group "$RESOURCE_GROUP" --container-name "$container" --image "$previous_image" --output none || fail 'Azure rechazó la recuperación'
  verify_revision "$previous_image" || fail 'revisión de recuperación no Healthy'
  if [[ "$destination" == chile-shared ]]; then
    verify_chile_served_revision "$previous_image" || fail 'RECUPERACIÓN NO VERIFICADA: el digest anterior no recibe el 100% del tráfico Chile'
  fi
  normalize_app "$after" > "$work/after-normalized.json"
  cmp -s "$work/current-normalized.json" "$work/after-normalized.json" || fail 'la configuración cambió durante la recuperación'
  printf 'ROLLBACK COORDINADO VERIFICADO: servicio=%s revision=%s image=%s.\n' "$service" "$(jq -r '.properties.latestRevisionName' "$after")" "$previous_image"
  exit 0
fi

validate_target
read_app > "$before" || fail "no se pudo inspeccionar ACA ${app}"
jq -e '.properties.template.containers | type == "array" and length > 0' "$before" >/dev/null || fail 'respuesta ACA sin lista de contenedores válida'
if [[ "$service" == api-gateway ]]; then
  jq -e '[.properties.template.containers[] | select(.name == "caddy")] | length == 1' "$before" >/dev/null || fail 'Gateway no contiene exactamente un sidecar caddy; actualización cancelada'
fi
previous_image="$(container_image "$before")" || fail 'no se encontró exactamente un contenedor de destino'
[[ "$previous_image" == "$REPOSITORY/$service@sha256:"* && "${previous_image##*@sha256:}" =~ ^[0-9a-f]{64}$ ]] || fail 'la imagen previa no es un digest oficial verificable; rollback seguro imposible'
if [[ "$destination" == chile-shared ]]; then
  verify_chile_served_revision "$previous_image" || fail 'tráfico Chile previo es ambiguo/incompatible con un despliegue individual; no se modifica Azure'
  previous_served_revision="$verified_served_revision"
fi
normalize_app "$before" > "$work/before-normalized.json"
baseline_hash="$(sha256sum "$work/before-normalized.json" | awk '{print $1}')"
if [[ -n "${DEPLOY_RECEIPT:-}" ]]; then
  origin=''
  if [[ "$destination" == chile-shared ]]; then origin="$(get_chile_origin)"; fi
  jq -n --arg service "$service" --arg destination "$DESTINATION" --arg environment "$DEPLOYMENT_ENVIRONMENT" --arg run_id "${GITHUB_RUN_ID:-}" --arg resource_group "$RESOURCE_GROUP" --arg aca_environment "$ACA_ENVIRONMENT" --arg location "$REGION" --arg subscription "$SUBSCRIPTION" --arg app_id "$(jq -r '.id' "$before")" --arg container "$container" --arg previous "$previous_image" --arg target "$image" --arg config "$baseline_hash" --arg origin "$origin" '{service:$service,destination:$destination,github_environment:$environment,workflow_run_id:$run_id,resource_group:$resource_group,aca_environment:$aca_environment,location:$location,subscription_id:$subscription,app_resource_id:$app_id,container:$container,previous:$previous,target:$target,digest_candidate:($target | split("@")[1]),origin_https:(if $origin == "" then null else $origin end),config_sha256:$config}' > "$DEPLOY_RECEIPT"
fi

if [[ "$previous_image" == "$image" ]]; then
  printf 'Idempotencia: %s ya usa la imagen/digest solicitado; verificando revisión existente.\n' "$service"
  verify_revision "$image" || fail 'imagen ya presente, pero revisión activa no está Healthy'
  if [[ "$destination" == chile-shared ]]; then
    verify_chile_served_revision "$image" || fail 'tráfico efectivo Chile no apunta exclusivamente a la revisión latest con digest candidato'
    [[ -n "${DEPLOY_RECEIPT:-}" ]] && jq --arg revision "$verified_served_revision" --arg digest "$verified_served_digest" '.served_revision=$revision | .served_digest=$digest | .traffic_weight=100' "$DEPLOY_RECEIPT" > "$DEPLOY_RECEIPT.tmp" && mv "$DEPLOY_RECEIPT.tmp" "$DEPLOY_RECEIPT"
  fi
  printf 'REVISIÓN VERIFICADA: servicio=%s modo=%s réplicas=%s salud=%s.\n' "$service" "$verified_mode" "$verified_replicas" "$verified_health"
else
  # Store only hashes and immutable image references; never serialize ACA secrets into artifacts.
  printf 'Actualizando solo %s/%s en %s; configuración ACA se comparará sin imprimirla.\n' "$app" "$container" "$RESOURCE_GROUP"
  failure_stage=''
  if ! az containerapp update --subscription "$SUBSCRIPTION" --name "$app" --resource-group "$RESOURCE_GROUP" --container-name "$container" --image "$image" --output none; then
    failure_stage='az containerapp update rechazó el cambio de imagen'
  elif ! verify_revision "$image"; then
    failure_stage="verificación latest/ready/health/running: $revision_verify_detail"
  elif [[ "$destination" == chile-shared ]] && ! verify_chile_served_revision "$image"; then
    failure_stage='revisión sana pero el modo ACA/traffic no asigna 100% a latestRevision'
  elif ! normalize_app "$after" > "$work/after-normalized.json"; then
    failure_stage='no se pudo normalizar la configuración ACA posterior al cambio'
  elif ! cmp -s "$work/before-normalized.json" "$work/after-normalized.json"; then
    failure_stage='drift de configuración persistente entre baseline y readback'
  elif [[ "$destination" == chile-shared ]] && ! verify_chile_served_revision "$image"; then
    failure_stage='el tráfico Chile cambió durante la verificación final'
  fi
  if [[ -z "$failure_stage" ]]; then
    if [[ "$destination" == chile-shared && -n "${DEPLOY_RECEIPT:-}" ]]; then
      jq --arg revision "$verified_served_revision" --arg digest "$verified_served_digest" '.served_revision=$revision | .served_digest=$digest | .traffic_weight=100' "$DEPLOY_RECEIPT" > "$DEPLOY_RECEIPT.tmp" && mv "$DEPLOY_RECEIPT.tmp" "$DEPLOY_RECEIPT"
    fi
    printf 'Despliegue verificado: servicio=%s revision=%s image=%s modo=%s réplicas=%s salud=%s.\n' "$service" "$(jq -r '.properties.latestRevisionName' "$after")" "$image" "$verified_mode" "$verified_replicas" "$verified_health"
    exit 0
  fi

  printf 'Fallo tras actualización de %s; etapa=%s.\n' "$service" "$failure_stage" >&2
  read_app > "$after" || fail 'ROLLBACK NO VERIFICADO: no se pudo releer ACA; revisar manualmente'
  current="$(container_image "$after" 2>/dev/null || true)"
  normalize_app "$after" > "$work/failure-normalized.json" || fail 'ROLLBACK NO VERIFICADO: no se pudo comparar la configuración persistente'
  failure_hash="$(sha256sum "$work/failure-normalized.json" | awk '{print $1}')"
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
  if [[ "$destination" == chile-shared ]] && ! verify_chile_transition_traffic "$image" "$previous_image" "$previous_served_revision"; then
    printf 'ROLLBACK OMITIDO: drift o tráfico ambiguo de Chile; no se sobrescribe el enrutamiento.\n' >&2
    exit 1
  fi
  if az containerapp update --subscription "$SUBSCRIPTION" --name "$app" --resource-group "$RESOURCE_GROUP" --container-name "$container" --image "$previous_image" --output none && \
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
