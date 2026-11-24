#!/usr/bin/env bash
set -Eeuo pipefail

fail() { printf 'Destino CD rechazado: %s\n' "$1" >&2; exit 2; }
[[ $# == 3 ]] || fail 'uso: resolve-deployment-target.sh <destination> <pilot_self_review:true|false> <service>'

destination="$1"
pilot_self_review="$2"
service="$3"
targets_file="$(dirname "${BASH_SOURCE[0]}")/deployment-targets.json"
jq -e '.services | type == "array" and length == 9 and all(.[]; type == "string")' "$targets_file" >/dev/null || fail 'catálogo de destinos inválido'
jq -e --arg service "$service" '.services | index($service) != null or $service == "all"' "$targets_file" >/dev/null || fail 'servicio fuera de la allowlist'

case "$pilot_self_review" in true|false) ;; *) fail 'pilot_self_review debe ser true o false' ;; esac
[[ "$destination" == brazil-isolated || "$destination" == chile-shared ]] || fail 'destino desconocido; no se aplica fallback'

if [[ "$destination" == chile-shared ]]; then
  [[ "$pilot_self_review" == false ]] || fail 'PILOT_SELF_REVIEW_CHILE_REJECTED'
  [[ "$service" != all ]] || fail 'CHILE_ALL_SERVICES_REJECTED'
  jq -ce --arg destination "$destination" --arg service "$service" '
    . as $root
    | $root.destinations[$destination]
    | select(. != null)
    | select($service as $s | ($root.services | index($s)) != null)
    | . + {destination:$destination,subscriptionId:$root.subscriptionId,pilotSelfReview:false}
  ' "$targets_file"
  exit 0
fi

if [[ "$pilot_self_review" == true ]]; then
  jq -ce --arg service "$service" '
    . as $root
    | $root.pilot
    | select(.services | index($service) != null)
    | . + {destination:"brazil-isolated",subscriptionId:$root.subscriptionId,pilotSelfReview:true}
  ' "$targets_file" || fail 'PILOT_SELF_REVIEW_SCOPE_REJECTED'
  exit 0
fi

jq -ce --arg destination "$destination" '
  . as $root
  | $root.destinations[$destination]
  | select(. != null)
  | . + {destination:$destination,subscriptionId:$root.subscriptionId,pilotSelfReview:false}
' "$targets_file"
