#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly REGISTRY="$SCRIPT_DIR/services-ci.psv"
service_name="${1:-}"

if ! awk -F'|' -v service="$service_name" '$1 == service { found=1 } END { exit !found }' "$REGISTRY"; then
  printf 'servicio de compilación no autorizado\n' >&2
  exit 1
fi

npm run "build:$service_name"
printf "import './%s/main.js';\n" "$service_name" > dist/apps/g6-service-entrypoint.mjs
