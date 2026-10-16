#!/usr/bin/env bash
set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=service-registry.sh
source "${SCRIPT_DIR}/service-registry.sh"

usage() {
  echo 'Uso: select-cd-services.sh manual <servicio> | select-cd-services.sh automatic [argumentos]' >&2
}

mode="${1:-}"
case "$mode" in
  automatic)
    # Requisito de seguridad CD Oracle:
    # Se eliminan los despliegues automáticos en push o merge a master.
    # No se selecciona ningún servicio automáticamente.
    echo 'Despliegues automáticos deshabilitados: push o merge a master no despliegan ningún servicio. El CD Oracle requiere workflow_dispatch manual por servicio.' >&2
    printf '[]\n'
    exit 0
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
