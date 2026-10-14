#!/usr/bin/env bash

# Lee el registro de datos sin ejecutarlo como código.
readonly G6_SERVICE_REGISTRY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/services.psv"
readonly -a G6_EXPECTED_SERVICES=(api-gateway bulk-svc catalog-svc combos-svc inventory-svc price-audit-svc pricing-svc promotions-svc taxonomy-svc)

g6_service_config() {
  local requested="${1:-}"
  local service enabled port build_script main_module image_name compose_file project compose_unit container state_dir runtime_env_file expected_service
  [[ "$requested" =~ ^[a-z][a-z0-9-]{0,31}$ ]] || return 64
  for expected_service in "${G6_EXPECTED_SERVICES[@]}"; do
    [[ "$requested" == "$expected_service" ]] && break
  done
  [[ "${expected_service:-}" == "$requested" ]] || return 64

  while IFS='|' read -r service enabled port build_script main_module image_name compose_file project compose_unit container state_dir runtime_env_file; do
    [[ -n "$service" && "$service" != \#* ]] || continue
    [[ "$service" =~ ^[a-z][a-z0-9-]{0,31}$ && "$enabled" =~ ^(true|false)$ ]] || return 65
    [[ "$port" =~ ^[0-9]{4,5}$ ]] || return 65
    [[ "$build_script" == "build:${service}" && "$main_module" == "dist/apps/${service}/main.js" ]] || return 65
    [[ "$image_name" == "$service" ]] || return 65
    if [[ "$service" == inventory-svc ]]; then
      [[ "$compose_file" == /opt/g6-productos-ofertas/inventory/docker-compose.inventory.yml &&
        "$project" == g6-inventory && "$compose_unit" == inventory-svc &&
        "$container" == g6-inventory-svc && "$state_dir" == /var/lib/g6-inventory &&
        "$runtime_env_file" == /etc/g6-inventory/runtime.env ]] || return 65
    else
      [[ "$compose_file" == /opt/g6-productos-ofertas/shared/docker-compose.service.yml &&
        "$project" == "g6-${service}" && "$compose_unit" == service &&
        "$container" == "g6-${service}" &&
        "$state_dir" == "/var/lib/g6-productos-ofertas/${service}" &&
        "$runtime_env_file" == "/etc/g6-${service}/runtime.env" ]] || return 65
    fi

    if [[ "$service" == "$requested" ]]; then
      G6_SERVICE_NAME="$service"
      G6_SERVICE_ENABLED="$enabled"
      G6_SERVICE_PORT="$port"
      G6_SERVICE_BUILD_SCRIPT="$build_script"
      G6_SERVICE_MAIN="$main_module"
      G6_SERVICE_IMAGE_NAME="$image_name"
      G6_SERVICE_COMPOSE_FILE="$compose_file"
      G6_SERVICE_COMPOSE_PROJECT="$project"
      G6_SERVICE_COMPOSE_UNIT="$compose_unit"
      G6_SERVICE_CONTAINER="$container"
      G6_SERVICE_STATE_DIR="$state_dir"
      G6_SERVICE_ENV_FILE="$runtime_env_file"
      return 0
    fi
  done < "$G6_SERVICE_REGISTRY"
  return 64
}

g6_enabled_services_json() {
  local service first=true count=0
  local -A seen=() seen_ports=()
  printf '['
  while IFS='|' read -r service enabled port _; do
    [[ -n "$service" && "$service" != \#* ]] || continue
    [[ ! -v "seen[$service]" ]] || return 65
    [[ ! -v "seen_ports[$port]" ]] || return 65
    seen["$service"]=1
    seen_ports["$port"]=1
    ((count += 1))
    g6_service_config "$service" || return
    if [[ "$G6_SERVICE_ENABLED" == true ]]; then
      [[ "$first" == true ]] || printf ','
      printf '"%s"' "$service"
      first=false
    fi
  done < "$G6_SERVICE_REGISTRY"
  [[ "$count" == 9 ]] || return 65
  for service in "${G6_EXPECTED_SERVICES[@]}"; do
    [[ -v "seen[$service]" ]] || return 65
  done
  printf ']\n'
}
