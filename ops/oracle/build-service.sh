#!/usr/bin/env bash
set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=service-registry.sh
source "${SCRIPT_DIR}/service-registry.sh"

service_name="${1:-}"
g6_service_config "$service_name" || {
  printf 'servicio de compilación no autorizado\n' >&2
  exit 1
}

npm run "$G6_SERVICE_BUILD_SCRIPT"
readonly ENTRYPOINT_MODULE="${G6_SERVICE_MAIN#dist/apps/}"
printf "import './%s';\n" "$ENTRYPOINT_MODULE" > dist/apps/g6-service-entrypoint.mjs
