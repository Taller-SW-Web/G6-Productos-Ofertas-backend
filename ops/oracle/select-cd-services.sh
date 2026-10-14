#!/usr/bin/env bash
set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=service-registry.sh
source "${SCRIPT_DIR}/service-registry.sh"

mode="${1:-}"
case "$mode" in
  automatic)
    [[ $# == 1 ]] || { echo 'Uso: select-cd-services.sh automatic' >&2; exit 64; }
    # No hay un cursor verificable del estado activo por servicio en Oracle.
    # Cada CI exitoso de master vuelve a intentar todos los servicios habilitados.
    g6_enabled_services_json
    ;;
  manual)
    [[ $# == 2 ]] || { echo 'Uso: select-cd-services.sh manual <servicio>' >&2; exit 64; }
    service="$2"
    g6_service_config "$service" || { echo 'Servicio fuera del registro cerrado.' >&2; exit 64; }
    [[ "$G6_SERVICE_ENABLED" == true ]] || { echo 'Servicio registrado pero deshabilitado.' >&2; exit 65; }
    printf '["%s"]\n' "$service"
    ;;
  *)
    echo 'Modo de selección no autorizado.' >&2
    exit 64
    ;;
esac
