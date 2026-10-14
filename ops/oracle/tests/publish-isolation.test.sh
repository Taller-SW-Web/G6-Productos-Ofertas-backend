#!/usr/bin/env bash
set -Eeuo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
readonly WORKFLOW="${ROOT}/.github/workflows/cd-services-oracle.yml"
readonly LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT

grep -Eq '^  release:$' "$WORKFLOW"
grep -Eq '^      fail-fast: false$' "$WORKFLOW"
grep -Fq '        service: ${{ fromJSON(needs.prepare.outputs.services) }}' "$WORKFLOW"
grep -Fq '      group: deploy-g6-services-oracle-${{ github.repository }}-${{ matrix.service }}' "$WORKFLOW"
grep -Fq '      cancel-in-progress: false' "$WORKFLOW"
grep -Eq '^        type: choice$' "$WORKFLOW"
if grep -Eq '^  publish:$|needs\.publish\.result' "$WORKFLOW"; then
  echo 'FAIL: la publicación todavía es una barrera agregada para otras filas.' >&2
  exit 1
fi

publish_one() {
  local service="$1"
  printf 'publish:%s\n' "$service" >> "$LOG"
  [[ "$service" != catalog-svc ]]
}
release_one() {
  local service="$1"
  publish_one "$service" || return
  printf 'deploy:%s\n' "$service" >> "$LOG"
}

if release_one catalog-svc; then
  echo 'FAIL: la publicación simulada debía fallar.' >&2
  exit 1
fi
release_one inventory-svc
[[ "$(<"$LOG")" == $'publish:catalog-svc\npublish:inventory-svc\ndeploy:inventory-svc' ]] || {
  echo 'FAIL: un fallo de publicación afectó el servicio independiente.' >&2
  exit 1
}
printf 'PASS: publicación fallida aislada de otra fila de servicio\n'
