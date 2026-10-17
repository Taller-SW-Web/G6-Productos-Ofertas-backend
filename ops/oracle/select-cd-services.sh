#!/usr/bin/env bash
set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=service-registry.sh
source "${SCRIPT_DIR}/service-registry.sh"

usage() {
  echo 'Uso: select-cd-services.sh manual <servicio> | select-cd-services.sh automatic <owner/repo>' >&2
}

mode="${1:-}"
case "$mode" in
  automatic)
    [[ $# == 2 ]] || { usage; exit 64; }
    readonly authorization_file="${SCRIPT_DIR}/auto-release-authorization.psv"
    [[ -f "$authorization_file" ]] || { echo 'No existe la autorización automática por servicio.' >&2; exit 65; }
    header="$(head -n 1 "$authorization_file")"
    [[ "$header" == '#auto-release-authorization-version=1' ]] || { echo 'Versión de autorización automática incompatible.' >&2; exit 65; }
    repository="$2"
    [[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { usage; exit 64; }
    declare -A auto_seen=()
    service= enabled= manual_deployment_id= readiness_evidence= expected= count=0 first=true
    declare -a automatic_services=()
    while IFS='|' read -r service enabled manual_deployment_id readiness_evidence; do
      [[ -n "$service" && "$service" != \#* ]] || continue
      g6_service_config "$service" || { echo 'Servicio inválido en la autorización automática.' >&2; exit 65; }
      [[ ! -v "auto_seen[$service]" ]] || { echo 'Servicio duplicado en la autorización automática.' >&2; exit 65; }
      auto_seen["$service"]=1
      ((count += 1))
      [[ "$enabled" =~ ^(true|false)$ ]] || { echo 'Flag automático inválido.' >&2; exit 65; }
      if [[ "$enabled" == true ]]; then
        [[ "$G6_SERVICE_ENABLED" == true ]] || { echo 'Servicio no autorizado para despliegue manual.' >&2; exit 65; }
        [[ "$manual_deployment_id" =~ ^[0-9]+$ ]] || { echo 'Falta el ID de liberación manual exitosa.' >&2; exit 65; }
        [[ "$readiness_evidence" =~ ^https://[^[:space:]|]+$ ]] || { echo 'Falta una referencia HTTPS de readiness o smoke funcional aprobado.' >&2; exit 65; }
        automatic_services+=("$service")
      else
        [[ -z "$manual_deployment_id" && -z "$readiness_evidence" ]] || { echo 'Las filas deshabilitadas deben permanecer vacías.' >&2; exit 65; }
      fi
    done < "$authorization_file"
    [[ "$count" == 9 ]] || { echo 'La autorización automática debe contener exactamente nueve servicios.' >&2; exit 65; }
    for expected in "${G6_EXPECTED_SERVICES[@]}"; do
      [[ -v "auto_seen[$expected]" ]] || { echo 'Falta un servicio en la autorización automática.' >&2; exit 65; }
    done
    printf '['
    for service in "${automatic_services[@]}"; do
      [[ "$first" == true ]] || printf ','
      printf '"%s"' "$service"
      first=false
    done
    printf ']\n'
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
