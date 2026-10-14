#!/usr/bin/env bash
set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=service-registry.sh
source "${SCRIPT_DIR}/service-registry.sh"

usage() {
  echo 'Uso: github-deployment-api.sh create <owner/repo> <servicio> <sha> | status <owner/repo> <deployment-id> <success|failure>' >&2
}

valid_repository() { [[ "${1:-}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; }
valid_id() { [[ "${1:-}" =~ ^[0-9]+$ ]]; }

mode="${1:-}"
case "$mode" in
  create)
    [[ $# == 4 ]] || { usage; exit 64; }
    repository="$2" service="$3" sha="$4"
    valid_repository "$repository" || { usage; exit 64; }
    g6_service_config "$service" || { echo 'Servicio fuera del registro cerrado.' >&2; exit 64; }
    [[ "$G6_SERVICE_ENABLED" == true ]] || { echo 'Servicio registrado pero deshabilitado.' >&2; exit 65; }
    [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { usage; exit 64; }

    payload="$(mktemp)"
    trap 'rm -f "$payload"' EXIT
    jq -cn --arg ref "$sha" --arg environment "g6-oracle-${service}" \
      '{ref:$ref, task:"deploy", environment:$environment, auto_merge:false, required_contexts:[], production_environment:true}' \
      > "$payload"
    deployment_id="$(gh api --method POST "repos/${repository}/deployments" --input "$payload" --jq .id)"
    valid_id "$deployment_id" || { echo 'GitHub devolvió un ID de Deployment inválido.' >&2; exit 1; }
    gh api --method POST "repos/${repository}/deployments/${deployment_id}/statuses" \
      -f state=in_progress -f description='Despliegue Oracle en curso; aún no es una versión exitosa.' >/dev/null
    printf '%s\n' "$deployment_id"
    ;;
  status)
    [[ $# == 4 ]] || { usage; exit 64; }
    repository="$2" deployment_id="$3" state="$4"
    valid_repository "$repository" && valid_id "$deployment_id" || { usage; exit 64; }
    case "$state" in
      success) description='SSH completó el despliegue y sus verificaciones de salud.' ;;
      failure) description='El despliegue remoto no terminó correctamente; no se avanza el SHA exitoso.' ;;
      *) usage; exit 64 ;;
    esac
    gh api --method POST "repos/${repository}/deployments/${deployment_id}/statuses" \
      -f "state=${state}" -f "description=${description}" >/dev/null
    ;;
  *) usage; exit 64 ;;
esac
