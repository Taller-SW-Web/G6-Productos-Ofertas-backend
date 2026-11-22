#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  printf 'PUBLICACIÓN BLOQUEADA: %s\n' "$1" >&2
  exit 1
}

[[ $# == 3 ]] || fail 'uso: validate-publish-only-source.sh <service> <sha> <output-file>'
service="$1"
requested_sha="$2"
output_file="$3"
repository="${GITHUB_REPOSITORY:-}"
event_sha="${GITHUB_SHA:-}"
readonly authorized_repository='Taller-SW-Web/G6-Productos-Ofertas-backend'

if ! awk -F'|' -v service="$service" '$1 == service { found=1 } END { exit !found }' "$(dirname "${BASH_SOURCE[0]}")/services-ci.psv"; then
  fail 'servicio fuera de la allowlist de publicación'
fi
[[ "$requested_sha" =~ ^[0-9a-f]{40}$ ]] || fail 'SHA inválido'
[[ "$event_sha" =~ ^[0-9a-f]{40}$ && "$requested_sha" == "$event_sha" ]] ||
  fail 'el SHA solicitado no coincide con el SHA del evento workflow_dispatch'
[[ "${repository,,}" == "${authorized_repository,,}" ]] || fail 'GITHUB_REPOSITORY no autorizado'
[[ "${GITHUB_EVENT_NAME:-}" == workflow_dispatch && "${GITHUB_REF:-}" == refs/heads/master ]] ||
  fail 'la publicación requiere workflow_dispatch desde master'
case "${GITHUB_ACTOR:-}" in
  mrcastilla8|AXL031) ;;
  *) fail 'actor de publicación no autorizado' ;;
esac
case "${GITHUB_TRIGGERING_ACTOR:-}" in
  mrcastilla8|AXL031) ;;
  *) fail 'actor de reejecución no autorizado' ;;
esac
[[ -n "${GH_TOKEN:-}" ]] || fail 'GITHUB_TOKEN de solo lectura no disponible'
[[ -n "$output_file" ]] || fail 'archivo de outputs requerido'

repository="$authorized_repository"
current_master="$(gh api "repos/${repository}/commits/master" --jq '.sha')" ||
  fail 'no se pudo consultar la punta de master'
[[ "$current_master" =~ ^[0-9a-f]{40}$ && "$requested_sha" == "$current_master" ]] ||
  fail 'el SHA solicitado ya no es la punta vigente de master'

ci_success="$(gh run list \
  --repo "$repository" \
  --workflow ci.yml \
  --branch master \
  --commit "$requested_sha" \
  --limit 100 \
  --json conclusion,event,headBranch,headSha \
  --jq "any(.[]; .conclusion == \"success\" and .event == \"push\" and .headBranch == \"master\" and .headSha == \"$requested_sha\")")" ||
  fail 'no se pudo verificar el workflow de CI'
[[ "$ci_success" == true ]] || fail 'no existe CI push/master exitosa para el SHA exacto'

{
  printf 'sha=%s\n' "$requested_sha"
  printf 'service=%s\n' "$service"
  printf 'repository=%s\n' "$repository"
} >> "$output_file"
