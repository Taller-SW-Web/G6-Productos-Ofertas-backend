#!/usr/bin/env bash
set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=service-registry.sh
source "${SCRIPT_DIR}/service-registry.sh"

declare -A selected=()
unknown_change=false
change_count=0

while IFS= read -r -d '' path; do
  ((change_count += 1))
  matched=''
  for service in "${G6_EXPECTED_SERVICES[@]}"; do
    if [[ "$path" == "apps/${service}/"* ]]; then
      matched="$service"
      break
    fi
  done
  if [[ -z "$matched" ]]; then
    unknown_change=true
  else
    selected["$matched"]=1
  fi
done

if [[ "$unknown_change" == true || "$change_count" == 0 ]]; then
  g6_enabled_services_json
  exit
fi

printf '['
first=true
for service in "${G6_EXPECTED_SERVICES[@]}"; do
  [[ -v "selected[$service]" ]] || continue
  g6_service_config "$service"
  [[ "$G6_SERVICE_ENABLED" == true ]] || continue
  [[ "$first" == true ]] || printf ','
  printf '"%s"' "$service"
  first=false
done
printf ']\n'
