#!/usr/bin/env bash
set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=service-registry.sh
source "${SCRIPT_DIR}/service-registry.sh"

usage() {
  echo 'Uso: select-cd-services.sh automatic <owner/repo> <sha-master> | manual <servicio>' >&2
}

g6_last_successful_deployment_sha() {
  local service="$1" repository="$2" deployments deployment_id deployment_sha deployment_date
  local statuses latest_status status state status_date environment
  environment="g6-oracle-${service}"
  deployments="$(gh api --paginate --jq '.[] | [.id, .sha, .created_at] | @tsv' \
    "repos/${repository}/deployments?environment=${environment}&task=deploy&per_page=100")" || return 1
  [[ -n "$deployments" ]] || return 1

  while IFS=$'\t' read -r deployment_id deployment_sha deployment_date; do
    [[ "$deployment_id" =~ ^[0-9]+$ && "$deployment_sha" =~ ^[0-9a-f]{40}$ &&
      "$deployment_date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*Z$ ]] || return 1
    statuses="$(gh api --paginate --jq '.[] | [.state, .created_at] | @tsv' \
      "repos/${repository}/deployments/${deployment_id}/statuses?per_page=100")" || return 1
    [[ -n "$statuses" ]] || return 1
    latest_status="$(printf '%s\n' "$statuses" | LC_ALL=C sort -t $'\t' -k2,2r | sed -n '1p')"
    IFS=$'\t' read -r state status_date <<< "$latest_status"
    [[ "$status_date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*Z$ ]] || return 1
    case "$state" in
      success)
        printf '%s\n' "$deployment_sha"
        return 0
        ;;
      *)
        # A failed deployment may have rolled back or may have left the host
        # uncertain. Pending/cancelled/unknown states may still change it.
        # None is a trustworthy baseline: select this service conservatively.
        return 1
        ;;
    esac
  done < <(printf '%s\n' "$deployments" | LC_ALL=C sort -t $'\t' -k3,3r)
  return 1
}

g6_service_needs_update() {
  local service="$1" deployed_sha="$2" selected_sha="$3" paths_file path path_service
  local changed=false service_changed=false shared_changed=false
  if ! git merge-base --is-ancestor "$deployed_sha" "$selected_sha"; then
    return 2
  fi
  paths_file="$(mktemp)" || return 2
  if ! git diff --no-renames --name-only -z "$deployed_sha" "$selected_sha" > "$paths_file"; then
    rm -f "$paths_file"
    return 2
  fi
  while IFS= read -r -d '' path; do
    changed=true
    case "$path" in
      docs|docs/*|*.md) continue ;;
    esac
    if [[ "$path" == apps/* ]]; then
      path_service="${path#apps/}"
      path_service="${path_service%%/*}"
      if g6_service_config "$path_service"; then
        [[ "$path_service" == "$service" ]] && service_changed=true
        continue
      fi
    fi
    # Root dependencies, libraries, Dockerfiles, build configuration,
    # deployment files, unclassified paths and unknown applications are shared.
    shared_changed=true
    break
  done < "$paths_file"
  rm -f "$paths_file"
  [[ "$shared_changed" == true || "$service_changed" == true ]] && return 0
  [[ "$changed" == true ]] || return 1
  return 1
}

mode="${1:-}"
case "$mode" in
  automatic)
    [[ $# == 3 ]] || { usage; exit 64; }
    repository="$2"
    selected_sha="$3"
    [[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { usage; exit 64; }
    [[ "$selected_sha" =~ ^[0-9a-f]{40}$ ]] || { usage; exit 64; }
    selected=()
    for service in "${G6_EXPECTED_SERVICES[@]}"; do
      g6_service_config "$service" || { echo 'Registro de servicios inválido.' >&2; exit 65; }
      [[ "$G6_SERVICE_ENABLED" == true ]] || continue
      if ! deployed_sha="$(g6_last_successful_deployment_sha "$service" "$repository")"; then
        echo "Historial de despliegue no verificable para ${service}; se incluye por seguridad." >&2
        selected+=("$service")
        continue
      fi
      if g6_service_needs_update "$service" "$deployed_sha" "$selected_sha"; then
        selected+=("$service")
      else
        result=$?
        if [[ "$result" != 1 ]]; then
          echo "No se pudo comparar el historial de ${service}; se incluye por seguridad." >&2
          selected+=("$service")
        fi
      fi
    done
    printf '['
    for ((index = 0; index < ${#selected[@]}; index++)); do
      [[ "$index" == 0 ]] || printf ','
      printf '"%s"' "${selected[$index]}"
    done
    printf ']\n'
    ;;
  manual)
    [[ $# == 2 ]] || { usage; exit 64; }
    service="$2"
    g6_service_config "$service" || { echo 'Servicio fuera del registro cerrado.' >&2; exit 64; }
    [[ "$G6_SERVICE_ENABLED" == true ]] || { echo 'Servicio registrado pero deshabilitado.' >&2; exit 65; }
    printf '["%s"]\n' "$service"
    ;;
  *)
    usage
    exit 64
    ;;
esac
