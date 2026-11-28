#!/usr/bin/env bash
set -Eeuo pipefail

fail() { printf 'Protección del Environment no verificada: %s\n' "$1" >&2; exit 1; }
[[ $# == 1 || $# == 3 || $# == 6 ]] || fail 'uso: verify-environment-protection.sh <owner/repo> [environment service destination mode pilot]'
repository="$1"
[[ "$repository" == Taller-SW-Web/G6-Productos-Ofertas-backend ]] || fail 'repositorio no autorizado'
[[ -n "${GH_TOKEN:-}" ]] || fail 'se requiere GH_TOKEN de solo lectura'

environment_name="${2:-azure-h5}"
service="${3:-}"
destination="${4:-brazil-isolated}"
mode="${5:-deploy}"
pilot="${6:-false}"
[[ "$mode" == deploy || "$mode" == recovery ]] || fail 'modo no autorizado'
[[ "$pilot" == true || "$pilot" == false ]] || fail 'pilot_self_review inválido'
case "$environment_name:$destination:$pilot" in
  azure-h5:brazil-isolated:false) ;;
  azure-h5-pilot-234:brazil-isolated:true) [[ "$service" == pricing-svc || "$service" == price-audit-svc ]] || fail 'excepción #234 fuera de alcance' ;;
  azure-h5-chile:chile-shared:false) ;;
  *) fail 'combinación de destino y Environment no autorizada' ;;
esac
environment_path="repos/${repository}/environments/${environment_name}"
branch_policies_path="${environment_path}/deployment-branch-policies"
env_json="$(gh api -H 'X-GitHub-Api-Version: 2022-11-28' "$environment_path")" || fail 'el Environment no existe o no se pudo leer'

if [[ "$environment_name" == azure-h5-pilot-234 ]]; then
  required_reviewers="$(jq '[.protection_rules[]? | select(.type == "required_reviewers" and .prevent_self_review == false and (.reviewers | length == 1) and .reviewers[0].type == "User" and .reviewers[0].reviewer.id == 129343979)] | length' <<< "$env_json")"
  [[ "$required_reviewers" == 1 ]] || fail 'la excepción histórica del piloto no coincide'
  branch_mode="$(jq -r 'if .deployment_branch_policy.custom_branch_policies == true and .deployment_branch_policy.protected_branches == false then "custom" else "invalid" end' <<< "$env_json")"
  [[ "$branch_mode" == custom ]] || fail 'el piloto histórico debe restringir ramas a master'
  branch_policies="$(gh api -H 'X-GitHub-Api-Version: 2022-11-28' "$branch_policies_path")" || fail 'no se pudieron consultar las ramas autorizadas del piloto'
  [[ "$(jq -r '[.branch_policies[].name] | sort | join(",")' <<< "$branch_policies")" == master && "$(jq -r '[.branch_policies[].type] | join(",")' <<< "$branch_policies")" == branch ]] || fail 'el piloto histórico solo admite la rama master'
elif [[ "$environment_name" == azure-h5-chile ]]; then
  admin_bypass="$(jq -r '.can_admins_bypass | tostring' <<< "$env_json")"
  [[ "$admin_bypass" == false ]] || fail 'el Environment Chile permite bypass administrativo o no declara esa regla'
  jq -e '
    [.protection_rules[]? | select(.type == "required_reviewers")] |
    length == 1 and .[0].prevent_self_review == false and
    (.[0].reviewers | map({type, id: .reviewer.id}) | sort_by(.id)) == [
      {type: "User", id: 129343979},
      {type: "User", id: 143348512}
    ]
  ' <<< "$env_json" >/dev/null || fail 'Chile requiere exactamente a AXL031 y mrcastilla8 como reviewers y permite la autoaprobación explícita'
  branch_mode="$(jq -r 'if .deployment_branch_policy.custom_branch_policies == true and .deployment_branch_policy.protected_branches == false then "custom" else "invalid" end' <<< "$env_json")"
  [[ "$branch_mode" == custom ]] || fail 'la política Chile debe ser explícita y restringida a master'
  branch_policies="$(gh api -H 'X-GitHub-Api-Version: 2022-11-28' "$branch_policies_path")" || fail 'no se pudieron consultar las ramas autorizadas de Chile'
  [[ "$(jq -r '[.branch_policies[].name] | sort | join(",")' <<< "$branch_policies")" == master && "$(jq -r '[.branch_policies[].type] | join(",")' <<< "$branch_policies")" == branch ]] || fail 'Chile solo admite la rama master'
else
  admin_bypass="$(jq -r '.can_admins_bypass | tostring' <<< "$env_json")"
  [[ "$admin_bypass" == false ]] || fail 'el Environment permite bypass administrativo o no declara esa regla'
  required_reviewers="$(jq '[.protection_rules[]? | select(.type == "required_reviewers" and .prevent_self_review == true and (.reviewers | length > 0))] | length' <<< "$env_json")"
  [[ "$required_reviewers" == 1 ]] || fail 'Brasil requiere reviewers y prevención de autoaprobación'
  branch_mode="$(jq -r 'if .deployment_branch_policy.custom_branch_policies == true and .deployment_branch_policy.protected_branches == false then "custom" else "invalid" end' <<< "$env_json")"
  [[ "$branch_mode" == custom ]] || fail 'la política Brasil debe ser explícita y restringida a master'
  branch_policies="$(gh api -H 'X-GitHub-Api-Version: 2022-11-28' "$branch_policies_path")" || fail 'no se pudieron consultar las ramas autorizadas de Brasil'
  [[ "$(jq -r '[.branch_policies[].name] | sort | join(",")' <<< "$branch_policies")" == master && "$(jq -r '[.branch_policies[].type] | join(",")' <<< "$branch_policies")" == branch ]] || fail 'Brasil solo admite la rama master'
fi

printf 'PASS: %s protege destino %s, modo %s; rama master y aprobaciones validadas.\n' "$environment_name" "$destination" "$mode"
