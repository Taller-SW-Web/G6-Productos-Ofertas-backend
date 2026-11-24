#!/usr/bin/env bash
set -Eeuo pipefail

[[ $# == 5 ]] || { echo 'uso: reconcile-recovery.sh <servicios-json> <directorio-artefactos> <jobs-json> <destino> <environment>' >&2; exit 2; }
selected_json="$1"
artifact_dir="$2"
jobs_json="$3"
destination="$4"
environment="$5"
case "$destination:$environment" in brazil-isolated:azure-h5|brazil-isolated:azure-h5-pilot-234|chile-shared:azure-h5-chile) ;; *) echo 'destino/Environment no autorizados' >&2; exit 2 ;; esac
if [[ "$destination" == chile-shared ]] && [[ "$(jq 'length' <<< "$selected_json")" != 1 ]]; then echo 'Chile shared recovery solo admite el servicio individual del run.' >&2; exit 2; fi
targets_file="$(dirname "$0")/deployment-targets.json"
case "$destination:$environment" in
  brazil-isolated:azure-h5) target_path='destinations.brazil-isolated' ;;
  brazil-isolated:azure-h5-pilot-234) target_path='pilot' ;;
  chile-shared:azure-h5-chile) target_path='destinations.chile-shared' ;;
esac
target_resource_group="$(jq -r --arg key "$target_path" 'getpath($key | split(".")).resourceGroup' "$targets_file")"
target_environment="$(jq -r --arg key "$target_path" 'getpath($key | split(".")).acaEnvironment' "$targets_file")"
target_location="$(jq -r --arg key "$target_path" 'getpath($key | split(".")).location' "$targets_file")"
target_subscription="$(jq -r '.subscriptionId' "$targets_file")"
deploy_script="${DEPLOY_SCRIPT:-$(dirname "$0")/deploy.sh}"
summary_file="${GITHUB_STEP_SUMMARY:-/dev/null}"
readonly selected_json artifact_dir jobs_json destination environment deploy_script summary_file

jq -e 'type == "array" and length > 0 and all(.[]; type == "string")' <<< "$selected_json" >/dev/null || {
  echo 'ESTADO DESCONOCIDO: selección de servicios inválida.' | tee -a "$summary_file"
  exit 1
}
jq -e '.jobs | type == "array"' "$jobs_json" >/dev/null || {
  echo 'ESTADO DESCONOCIDO: no hay evidencia de ejecución de los jobs de despliegue.' | tee -a "$summary_file"
  exit 1
}
mkdir -p "$artifact_dir"
failed=0

while IFS= read -r service; do
  image_file="$artifact_dir/image-$service.txt"
  receipt_file="$artifact_dir/$service.receipt"
  job="$(jq -c --arg prefix "Desplegar $service en Azure" '[.jobs[] | select(.name == $prefix or (.name | startswith($prefix + " (")))] | first // empty' "$jobs_json")"
  job_json="$job"
  [[ -n "$job_json" ]] || job_json='{}'
  job_conclusion="$(jq -r '.conclusion // empty' <<< "$job_json")"
  deploy_step_conclusion="$(jq -r '[.steps[]? | select(.name == "Actualizar solo la imagen y verificar revisión/rollback") | .conclusion // empty] | first // empty' <<< "$job_json")"

  if [[ -f "$receipt_file" ]]; then
    service_in_receipt="$(jq -r '.service // empty' "$receipt_file" 2>/dev/null || true)"
    receipt_destination="$(jq -r '.destination // empty' "$receipt_file" 2>/dev/null || true)"
    receipt_environment="$(jq -r '.github_environment // empty' "$receipt_file" 2>/dev/null || true)"
    previous="$(jq -r '.previous // empty' "$receipt_file" 2>/dev/null || true)"
    target="$(jq -r '.target // empty' "$receipt_file" 2>/dev/null || true)"
    config_hash="$(jq -r '.config_sha256 // empty' "$receipt_file" 2>/dev/null || true)"
    receipt_rg="$(jq -r '.resource_group // empty' "$receipt_file" 2>/dev/null || true)"
    receipt_aca_environment="$(jq -r '.aca_environment // empty' "$receipt_file" 2>/dev/null || true)"
    receipt_location="$(jq -r '.location // empty' "$receipt_file" 2>/dev/null || true)"
    receipt_subscription="$(jq -r '.subscription_id // empty' "$receipt_file" 2>/dev/null || true)"
    receipt_app_id="$(jq -r '.app_resource_id // empty' "$receipt_file" 2>/dev/null || true)"
    receipt_container="$(jq -r '.container // empty' "$receipt_file" 2>/dev/null || true)"
    expected_app_id="/subscriptions/${target_subscription,,}/resourcegroups/${target_resource_group,,}/providers/microsoft.app/containerapps/${service,,}"
    if [[ "$service_in_receipt" != "$service" || "$receipt_destination" != "$destination" || "$receipt_environment" != "$environment" ||
          "$receipt_rg" != "$target_resource_group" || "$receipt_aca_environment" != "$target_environment" || "$receipt_location" != "$target_location" ||
          "${receipt_subscription,,}" != "${target_subscription,,}" || "${receipt_app_id,,}" != "$expected_app_id" || "$receipt_container" != "$service" ||
          ! -f "$image_file" || "$(cat "$image_file")" != "$target" ]]; then
      printf 'ESTADO DESCONOCIDO: %s tiene recibo incompleto o no coincide con la imagen publicada; no se modifica ACA.\n' "$service" | tee -a "$summary_file"
      failed=1
      continue
    fi
    printf 'ACTUALIZADO CON RECIBO: %s target=%s\n' "$service" "$target" | tee -a "$summary_file"
    if recovery_output="$(H5_DEPLOY_DESTINATION="$destination" H5_DEPLOY_ENVIRONMENT="$environment" H5_PILOT_SELF_REVIEW="$([[ "$environment" == azure-h5-pilot-234 ]] && echo true || echo false)" "$deploy_script" --restore "$service" "$previous" "$target" "$config_hash" 2>&1)"; then
      printf '%s\n' "$recovery_output"
      printf 'RECUPERADO: %s digest=%s; estado y configuración verificados.\n' "$service" "$previous" | tee -a "$summary_file"
    else
      printf '%s\nESTADO DESCONOCIDO: %s; recuperación no verificada. Inspección y acción manual supervisada requeridas.\n' "$recovery_output" "$service" | tee -a "$summary_file"
      failed=1
    fi
    continue
  fi

  if [[ "$job_conclusion" == skipped || "$deploy_step_conclusion" == skipped ]]; then
    printf 'NO DESPLEGADO: %s; GitHub Actions confirma que el paso de actualización fue omitido.\n' "$service" | tee -a "$summary_file"
    continue
  fi

  if [[ ! -f "$image_file" ]]; then
    printf 'ESTADO DESCONOCIDO: %s no tiene recibo ni artefacto con digest candidato; no se modifica ACA.\n' "$service" | tee -a "$summary_file"
    failed=1
    continue
  fi
  target="$(cat "$image_file")"
  if inspection_output="$(H5_DEPLOY_DESTINATION="$destination" H5_DEPLOY_ENVIRONMENT="$environment" H5_PILOT_SELF_REVIEW="$([[ "$environment" == azure-h5-pilot-234 ]] && echo true || echo false)" "$deploy_script" --inspect "$service" "$target" 2>&1)"; then
    if [[ "$inspection_output" == TARGET_ACTIVE:* ]]; then
      printf 'ACTUALIZADO SIN RECIBO: %s tiene activo el digest candidato %s. No se restaura sin el digest/configuración previos del recibo.\n' "$service" "$target" | tee -a "$summary_file"
    else
      printf '%s\nESTADO DESCONOCIDO: %s ejecutó el paso de despliegue, pero no hay recibo y el digest candidato no está activo; no se afirma que nunca se aplicó.\n' "$inspection_output" "$service" | tee -a "$summary_file"
    fi
  else
    printf '%s\nESTADO DESCONOCIDO: %s; ACA no pudo inspeccionarse de forma verificable.\n' "$inspection_output" "$service" | tee -a "$summary_file"
  fi
  failed=1
done < <(jq -r '.[]' <<< "$selected_json")

if (( failed == 0 )); then
  echo 'RECUPERACIÓN COMPLETA: cada servicio seleccionado tiene evidencia de recuperación verificada o evidencia GitHub de que no se desplegó.' | tee -a "$summary_file"
else
  echo 'RECUPERACIÓN PARCIAL/DESCONOCIDA: no declarar el conjunto recuperado. Revisar los servicios marcados y continuar manualmente bajo aprobación del environment azure-h5.' | tee -a "$summary_file"
  exit 1
fi
