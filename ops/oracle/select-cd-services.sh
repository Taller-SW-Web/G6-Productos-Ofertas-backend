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
  local statuses latest_status status_id state status_date environment
  environment="g6-oracle-${service}"
  deployments="$(gh api --paginate --jq '.[] | [.id, .sha, .created_at] | @tsv' \
    "repos/${repository}/deployments?environment=${environment}&task=deploy&per_page=100")" || return 1
  [[ -n "$deployments" ]] || return 1

  if ! printf '%s\n' "$deployments" | awk -F '\t' 'NF != 3 || seen[$1]++ { invalid=1 } END { exit invalid }'; then
    return 1
  fi
  while IFS=$'\t' read -r deployment_id deployment_sha deployment_date; do
    [[ "$deployment_id" =~ ^[0-9]+$ && "$deployment_sha" =~ ^[0-9a-f]{40}$ &&
      "$deployment_date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*Z$ ]] || return 1
    statuses="$(gh api --paginate --jq '.[] | [.id, .state, .created_at] | @tsv' \
      "repos/${repository}/deployments/${deployment_id}/statuses?per_page=100")" || return 1
    [[ -n "$statuses" ]] || return 1
    if ! printf '%s\n' "$statuses" | awk -F '\t' 'NF != 3 || seen[$1]++ { invalid=1 } END { exit invalid }'; then
      return 1
    fi
    # Equal timestamps are ordered by the numeric API ID, never by state text
    # or response order. Duplicate/malformed IDs above make the history unsafe.
    latest_status="$(printf '%s\n' "$statuses" | LC_ALL=C sort -t $'\t' -k3,3r -k1,1nr | sed -n '1p')"
    IFS=$'\t' read -r status_id state status_date <<< "$latest_status"
    [[ "$status_id" =~ ^[0-9]+$ ]] || return 1
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
  done < <(printf '%s\n' "$deployments" | LC_ALL=C sort -t $'\t' -k3,3r -k1,1nr)
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

# Find the nearest successful CI push on master before this tree along its
# first-parent history. Using a verified CI baseline captures all commits in a
# push, including an app/build commit followed by a control-only final commit.
g6_previous_successful_master_ci_sha() {
  local selected_sha="$1" repository="$2" runs run_number run_sha sha
  local commits_file
  local -A successful_ci_sha=()

  runs="$(gh api --paginate --jq '.workflow_runs[] | select(.event == "push" and .head_branch == "master" and .conclusion == "success") | [.run_number, .head_sha] | @tsv' \
    "repos/${repository}/actions/workflows/ci.yml/runs?branch=master&event=push&per_page=100")" || return 1
  [[ -n "$runs" ]] || return 1
  while IFS=$'\t' read -r run_number run_sha; do
    [[ "$run_number" =~ ^[0-9]+$ && "$run_sha" =~ ^[0-9a-f]{40}$ ]] || return 1
    [[ "$run_sha" == "$selected_sha" ]] || successful_ci_sha["$run_sha"]=1
  done <<< "$runs"

  commits_file="$(mktemp)" || return 1
  if ! git rev-list --first-parent "$selected_sha" > "$commits_file"; then
    rm -f "$commits_file"
    return 1
  fi
  while IFS= read -r sha; do
    [[ "$sha" == "$selected_sha" ]] && continue
    if [[ -v "successful_ci_sha[$sha]" ]]; then
      rm -f "$commits_file"
      printf '%s\n' "$sha"
      return 0
    fi
  done < "$commits_file"
  rm -f "$commits_file"
  return 1
}

# An infra-only range must not trigger the conservative "missing deployment
# history" fallback for Inventory. The strict allowlist deliberately excludes
# build inputs such as Dockerfile.service and build-service.sh. If no reliable
# successful master CI baseline is available, selection remains conservative.
g6_is_infrastructure_control_commit() {
  local selected_sha="$1" repository="$2" baseline_sha paths_file path count=0
  baseline_sha="$(g6_previous_successful_master_ci_sha "$selected_sha" "$repository")" || return 1
  paths_file="$(mktemp)" || return 1
  if ! git diff --no-renames --name-only -z "$baseline_sha" "$selected_sha" > "$paths_file"; then
    rm -f "$paths_file"
    return 1
  fi
  while IFS= read -r -d '' path; do
    ((count += 1))
    case "$path" in
      ops/oracle/README.md|\
      ops/oracle/deploy-g6-service.sh|\
      ops/oracle/deploy-inventory-svc.sh|\
      ops/oracle/docker-compose.inventory.http.yml|\
      ops/oracle/docker-compose.service.http.yml|\
      ops/oracle/docker-compose.service.yml|\
      ops/oracle/github-deployment-api.sh|\
      ops/oracle/select-cd-services.sh|\
      ops/oracle/service-registry.sh|\
      ops/oracle/services.psv|\
      ops/oracle/tests/*)
        ;;
      *)
        rm -f "$paths_file"
        return 1
        ;;
    esac
  done < "$paths_file"
  rm -f "$paths_file"
  ((count > 0))
}

mode="${1:-}"
case "$mode" in
  automatic)
    [[ $# == 3 ]] || { usage; exit 64; }
    repository="$2"
    selected_sha="$3"
    [[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { usage; exit 64; }
    [[ "$selected_sha" =~ ^[0-9a-f]{40}$ ]] || { usage; exit 64; }
    if g6_is_infrastructure_control_commit "$selected_sha" "$repository"; then
      echo 'Cambio de control de infraestructura: sin selección automática de servicios. El despliegue requiere dispatch explícito.' >&2
      printf '[]\n'
      exit 0
    fi
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
