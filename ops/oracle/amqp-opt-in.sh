#!/usr/bin/env bash

# Declaración cerrada de selección AMQP. El archivo contiene nombres de
# servicio, nunca valores de runtime ni secretos.
readonly G6_AMQP_OPT_IN_FILE="/etc/g6-productos-ofertas/amqp-opt-in.psv"
readonly G6_AMQP_NETWORK="g6-po_g6_backend"
readonly G6_AMQP_GENERIC_OVERLAY="/opt/g6-productos-ofertas/shared/docker-compose.service.amqp.yml"
readonly G6_AMQP_INVENTORY_OVERLAY="/opt/g6-productos-ofertas/inventory/docker-compose.inventory.amqp.yml"
readonly -a G6_AMQP_ALLOWED_SERVICES=(bulk-svc catalog-svc combos-svc inventory-svc price-audit-svc pricing-svc promotions-svc taxonomy-svc)

g6_amqp_service_allowed() {
  local candidate="$1" service
  for service in "${G6_AMQP_ALLOWED_SERVICES[@]}"; do
    [[ "$candidate" == "$service" ]] && return 0
  done
  return 1
}

g6_amqp_read_value() {
  local file="$1" key="$2"
  awk -v wanted="$key" '
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
    {
      separator = index($0, "=")
      if (!separator) next
      name = substr($0, 1, separator - 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", name)
      if (name != wanted) next
      value = substr($0, separator + 1)
      sub(/\r$/, "", value)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      if (value ~ /^".*"$/ || value ~ /^\047.*\047$/) value = substr(value, 2, length(value) - 2)
      count++
      if (length(value) > 0) present++
    }
    END { if (count != 1 || present != 1) exit 1; print "present" }
  ' "$file"
}

g6_amqp_validate_url_key() {
  local file="$1" key="$2" scheme_requirement="$3"
  awk -v wanted="$key" -v scheme_requirement="$scheme_requirement" '
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
    {
      separator = index($0, "=")
      if (!separator) next
      name = substr($0, 1, separator - 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", name)
      if (name != wanted) next
      value = substr($0, separator + 1)
      sub(/\r$/, "", value)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      if (value ~ /^".*"$/ || value ~ /^\047.*\047$/) value = substr(value, 2, length(value) - 2)
      count++
      scheme = value
      sub(/:.*/, "", scheme)
      authority = value
      sub(/^[A-Za-z]+:\/\//, "", authority)
      sub(/\/.*$/, "", authority)
      if (value !~ /^[A-Za-z]+:\/\// || value ~ /[[:space:]?#]/ || authority !~ /^[^:@\/]+:[^@\/]+@[^:@\/]+(:[0-9]+)?$/) bad = 1
      host = authority
      sub(/^.*@/, "", host)
      sub(/:[0-9]+$/, "", host)
      if (host != "rabbitmq") bad = 1
      if (scheme_requirement == "amqps" && scheme != "amqps") bad = 1
      if (scheme_requirement == "amqp-or-amqps" && scheme != "amqp" && scheme != "amqps") bad = 1
      if (scheme_requirement == "amqp" && scheme != "amqp") bad = 1
      path = value
      sub(/^[A-Za-z]+:\/\/[^\/]+/, "", path)
      if (path == "" || path == "/") bad = 1
    }
    END { if (count != 1 || bad) exit 1; print "valid" }
  ' "$file"
}

g6_amqp_validate_optional_boolean() {
  local file="$1" key="$2"
  awk -v wanted="$key" '
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
    { p=index($0,"="); if (!p) next; n=substr($0,1,p-1); gsub(/^[[:space:]]+|[[:space:]]+$/, "", n); if (n==wanted) {v=substr($0,p+1); sub(/\r$/, "", v); gsub(/^[[:space:]]+|[[:space:]]+$/, "", v); if (v ~ /^".*"$/ || v ~ /^\047.*\047$/) v=substr(v,2,length(v)-2); count++; if (v!="true" && v!="false") bad=1}}
    END {if(count>1 || bad) exit 1}
  ' "$file"
}

g6_amqp_validate_runtime_config() {
  local service="$1" file="$2" url_key="" scheme="amqp-or-amqps" flag_key="" value
  case "$service" in
    bulk-svc) url_key=BULK_AMQP_URL; flag_key=BULK_AMQP_ENABLED ;;
    catalog-svc) url_key=RABBITMQ_URL; flag_key=CATALOG_AMQP_ENABLED ;;
    combos-svc) url_key=COMBOS_AMQP_URL; flag_key=COMBOS_AMQP_ENABLED ;;
    inventory-svc) url_key=RABBITMQ_URL ;;
    price-audit-svc) url_key=PRICE_AUDIT_AMQP_URL; scheme=amqps ;;
    pricing-svc) url_key=PRICING_AMQP_URL; scheme=amqps ;;
    promotions-svc) url_key=RABBITMQ_URL ;;
    taxonomy-svc) url_key=RABBITMQ_URL ;;
    *) return 1 ;;
  esac
  [[ -r "$file" ]] || return 1
  g6_amqp_validate_url_key "$file" "$url_key" "$scheme" >/dev/null || return 1
  [[ -z "$flag_key" ]] || g6_amqp_validate_optional_boolean "$file" "$flag_key" || return 1
  case "$service" in
    promotions-svc)
      g6_amqp_validate_optional_boolean "$file" PROMOTIONS_COUPON_RUNTIME_ENABLED || return 1
      g6_amqp_validate_optional_boolean "$file" PROMOTIONS_DEPENDENCY_PROBES_ENABLED || return 1 ;;
    pricing-svc) g6_amqp_validate_optional_boolean "$file" PRICING_PRICE_CHANGED_PUBLISH_ENABLED || return 1 ;;
  esac
  if [[ "$service" == taxonomy-svc ]]; then
    g6_amqp_read_value "$file" TAXONOMY_CATALOG_AMQP_USER >/dev/null || return 1
  fi
  if [[ "$service" == catalog-svc ]]; then
    value="$(awk -F= '$1=="CATALOG_AMQP_ENABLED" {v=substr($0,index($0,"=")+1); sub(/\r$/, "", v); gsub(/^[[:space:]]+|[[:space:]]+$/, "", v); if (v ~ /^".*"$/ || v ~ /^\047.*\047$/) v=substr(v,2,length(v)-2); print v; exit}' "$file")"
    if [[ "$value" == true ]]; then
      local producer_users
      producer_users="$(awk -F= '$1=="CATALOG_AMQP_PRODUCER_USERS" {v=substr($0,index($0,"=")+1); sub(/\r$/, "", v); gsub(/^[[:space:]]+|[[:space:]]+$/, "", v); if (v ~ /^".*"$/ || v ~ /^\047.*\047$/) v=substr(v,2,length(v)-2); count++; if (count==1) print v} END {if(count!=1) exit 1}' "$file")" || return 1
      command -v jq >/dev/null 2>&1 || return 1
      jq -e 'type == "object" and (.["pricing-svc"] | type == "string" and length > 0) and (.["inventory-svc"] | type == "string" and length > 0) and (.["taxonomy-svc"] | type == "string" and length > 0) and (.["bulk-svc"] | type == "string" and length > 0) and ([.[]] | unique | length == length)' <<< "$producer_users" >/dev/null 2>&1 || return 1
    fi
  fi
}

g6_amqp_selected_services() {
  local file="$G6_AMQP_OPT_IN_FILE" line service seen=" " metadata owner mode
  G6_AMQP_SERVICES=()
  [[ ! -e "$file" ]] && return 0
  [[ -f "$file" && ! -L "$file" && -r "$file" ]] || return 1
  metadata="$(stat -c '%u:%a' "$file" 2>/dev/null)" || return 1
  IFS=':' read -r owner mode <<< "$metadata"
  [[ "$owner" == 0 && "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
  (( (8#$mode & 0022) == 0 )) || return 1
  IFS= read -r line < "$file" || return 1
  [[ "$line" == '#g6-amqp-opt-in-version=1' ]] || return 1
  while IFS= read -r service || [[ -n "$service" ]]; do
    [[ -z "$service" || "$service" == \#* ]] && continue
    [[ "$service" =~ ^[a-z][a-z0-9-]{0,31}$ ]] || return 1
    g6_amqp_service_allowed "$service" || return 1
    [[ "$seen" != *" $service "* ]] || return 1
    seen+="$service "
    G6_AMQP_SERVICES+=("$service")
  done < <(tail -n +2 "$file")
}

g6_amqp_service_opted_in() {
  local service="$1" candidate
  G6_AMQP_SELECTED=false
  g6_amqp_selected_services || return 1
  for candidate in "${G6_AMQP_SERVICES[@]}"; do
    if [[ "$candidate" == "$service" ]]; then G6_AMQP_SELECTED=true; break; fi
  done
  [[ "$G6_AMQP_SELECTED" != true ]] || g6_amqp_validate_runtime_config "$service" "$G6_SERVICE_ENV_FILE"
}

g6_amqp_validate_network() {
  local target_container="$1" target_alias="$G6_SERVICE_IMAGE_NAME" contract members member metadata expected_alias expected_project expected_unit identity actual_unit actual_project aliases alias previous network_name
  local driver scope internal attachable ingress config_only ipam_driver ipam_configs options_count
  local target_name="$G6_SERVICE_NAME" target_enabled="$G6_SERVICE_ENABLED" target_port="$G6_SERVICE_PORT" target_port_env="$G6_SERVICE_PORT_ENV"
  local target_build_script="$G6_SERVICE_BUILD_SCRIPT" target_main="$G6_SERVICE_MAIN" target_image_name="$G6_SERVICE_IMAGE_NAME"
  local target_compose_file="$G6_SERVICE_COMPOSE_FILE" target_project="$G6_SERVICE_COMPOSE_PROJECT" target_unit="$G6_SERVICE_COMPOSE_UNIT"
  local target_container_name="$G6_SERVICE_CONTAINER" target_state_dir="$G6_SERVICE_STATE_DIR" target_env_file="$G6_SERVICE_ENV_FILE"
  local -A seen_aliases=()
  local -A selected=()
  local service
  for service in "${G6_AMQP_SERVICES[@]}"; do selected["g6-${service}"]=1; done
  selected["$target_container"]=1
  contract="$(docker network inspect --format '{{.Name}}|{{.Driver}}|{{.Scope}}|{{.Internal}}|{{.Attachable}}|{{.Ingress}}|{{.ConfigOnly}}|{{.IPAM.Driver}}|{{len .IPAM.Config}}|{{len .Options}}' "$G6_AMQP_NETWORK" 2>/dev/null)" || return 1
  IFS='|' read -r network_name driver scope internal attachable ingress config_only ipam_driver ipam_configs options_count <<< "$contract"
  [[ "$network_name" == "$G6_AMQP_NETWORK" && "$driver" == bridge && "$scope" == local && "$internal" == false && "$attachable" == false && "$ingress" == false && "$config_only" == false && "$ipam_driver" == default && "$ipam_configs" =~ ^[1-9][0-9]*$ && "$options_count" == 0 ]] || return 1
  members="$(docker network inspect --format '{{range $id, $container := .Containers}}{{$container.Name}}{{"\n"}}{{end}}' "$G6_AMQP_NETWORK" 2>/dev/null)" || return 1
  [[ -n "$members" ]] || return 1
  while IFS= read -r member; do
    [[ -n "$member" ]] || continue
    if [[ "$member" == g6-po-rabbitmq-1 ]]; then
      expected_project=g6-po; expected_unit=rabbitmq; expected_alias=rabbitmq
    else
      [[ -v "selected[$member]" ]] || return 1
      service="${member#g6-}"
      g6_service_config "$service" || return 1
      expected_project="$G6_SERVICE_COMPOSE_PROJECT"; expected_unit="$G6_SERVICE_COMPOSE_UNIT"; expected_alias="$service"
    fi
    identity="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.project"}}' "$member" 2>/dev/null)" || return 1
    IFS='|' read -r actual_unit actual_project <<< "$identity"
    [[ "$actual_unit" == "$expected_unit" && "$actual_project" == "$expected_project" ]] || return 1
    aliases="$(docker inspect --format '{{range $name, $network := .NetworkSettings.Networks}}{{if eq $name "g6-po_g6_backend"}}{{range $network.Aliases}}{{.}}{{"\n"}}{{end}}{{end}}{{end}}' "$member" 2>/dev/null)" || return 1
    local alias_found=false
    while IFS= read -r alias; do
      [[ -n "$alias" ]] || continue
      [[ "$alias" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$ ]] || return 1
      [[ "$alias" != "$expected_alias" ]] || alias_found=true
      [[ "$alias" != "$target_alias" || "$member" == "$target_container" ]] || return 1
      previous="${seen_aliases[$alias]:-}"
      if [[ -n "$previous" && "$previous" != "$member" ]]; then
        [[ "$alias" == service && "$member" != g6-po-rabbitmq-1 && "$previous" != g6-po-rabbitmq-1 ]] || return 1
      fi
      seen_aliases["$alias"]="$member"
    done <<< "$aliases"
    [[ "$alias_found" == true ]] || return 1
  done <<< "$members"
  [[ " ${members//$'\n'/ } " == *" g6-po-rabbitmq-1 "* ]] || return 1
  G6_SERVICE_NAME="$target_name"
  G6_SERVICE_ENABLED="$target_enabled"
  G6_SERVICE_PORT="$target_port"
  G6_SERVICE_PORT_ENV="$target_port_env"
  G6_SERVICE_BUILD_SCRIPT="$target_build_script"
  G6_SERVICE_MAIN="$target_main"
  G6_SERVICE_IMAGE_NAME="$target_image_name"
  G6_SERVICE_COMPOSE_FILE="$target_compose_file"
  G6_SERVICE_COMPOSE_PROJECT="$target_project"
  G6_SERVICE_COMPOSE_UNIT="$target_unit"
  G6_SERVICE_CONTAINER="$target_container_name"
  G6_SERVICE_STATE_DIR="$target_state_dir"
  G6_SERVICE_ENV_FILE="$target_env_file"
}
