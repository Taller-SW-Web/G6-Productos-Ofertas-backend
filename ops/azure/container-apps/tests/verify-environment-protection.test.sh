#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
VERIFIER="$ROOT/ops/azure/container-apps/verify-environment-protection.sh"
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT
mkdir "$TEMP/bin"
cat > "$TEMP/bin/gh" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >> "${GH_CALL_LOG:?}"
case "$*" in
  *'deployment-branch-policies'*) names="${MOCK_BRANCHES:-master}"; policies="$(jq -cn --arg names "$names" --arg type "${MOCK_TYPE:-branch}" '$names|split(",")|map({name:.,type:$type})')"; count="$(jq 'length' <<< "$policies")"; printf '{"total_count":%s,"branch_policies":%s}' "$count" "$policies" ;;
  *'azure-h5-pilot-234'*) printf '{"deployment_branch_policy":{"custom_branch_policies":true,"protected_branches":false},"protection_rules":[{"type":"required_reviewers","prevent_self_review":false,"reviewers":[{"type":"User","reviewer":{"id":129343979}}]}]}' ;;
  *'/environments/'*)
    [[ "${MOCK_ENV_EXISTS:-true}" == true ]] || exit 1
    if [[ "$*" == *'azure-h5-chile'* ]]; then
      self_default=false; id_default=143348512; count_default=2; second_default=129343979
    else
      self_default=true; id_default=1; count_default=1; second_default=2
    fi
    count="${MOCK_REVIEWER_COUNT:-$count_default}"
    if [[ "$count" == 0 ]]; then reviewers='[]'
    elif [[ "$count" == 1 ]]; then reviewers="$(jq -cn --arg type "${MOCK_REVIEWER_TYPE:-User}" --argjson id "${MOCK_REVIEWER_ID:-$id_default}" '[{type:$type,reviewer:{id:$id}}]')"
    else reviewers="$(jq -cn --arg type "${MOCK_REVIEWER_TYPE:-User}" --argjson id "${MOCK_REVIEWER_ID:-$id_default}" --argjson second "${MOCK_SECOND_REVIEWER_ID:-$second_default}" --argjson count "$count" '
      [{type:$type,reviewer:{id:$id}},{type:"User",reviewer:{id:$second}}] +
      (if $count == 3 then [{type:"User",reviewer:{id:2}}] else [] end)
    ')"; fi
    rules='[]'
    if [[ "${MOCK_REQUIRED_REVIEWERS:-true}" == true ]]; then rules="$(jq -cn --argjson self "${MOCK_SELF_REVIEW:-$self_default}" --argjson reviewers "$reviewers" '[{type:"required_reviewers",prevent_self_review:$self,reviewers:$reviewers}]')"; fi
    printf '{"name":"%s","can_admins_bypass":%s,"protection_rules":%s,"deployment_branch_policy":{"custom_branch_policies":true,"protected_branches":false}}' "${MOCK_ENV_NAME:-$(if [[ "$*" == *'azure-h5-chile'* ]]; then printf azure-h5-chile; else printf azure-h5; fi)}" "${MOCK_BYPASS:-false}" "$rules"
    ;;
  *) exit 41 ;;
esac
MOCK
chmod +x "$TEMP/bin/gh"
export PATH="$TEMP/bin:$PATH" GH_TOKEN=fixture
export GH_CALL_LOG="$TEMP/gh-calls.log"
repo=Taller-SW-Web/G6-Productos-Ofertas-backend
bash "$VERIFIER" "$repo" >/dev/null
bash "$VERIFIER" "$repo" azure-h5-chile promotions-svc chile-shared deploy false >/dev/null
MOCK_ENABLED=False MOCK_REVIEWER_ID=129343979 MOCK_SECOND_REVIEWER_ID=143348512 \
  bash "$VERIFIER" "$repo" azure-h5-chile promotions-svc chile-shared recovery false >/dev/null
echo 'PASS: Chile accepts only the two authorized reviewers in either order for deployment and recovery'
if grep -Fq '/variables/AZURE_CHILE_DEPLOY_ENABLED' "$GH_CALL_LOG"; then echo 'FAIL: variable REST endpoint was queried by protection verifier' >&2; exit 1; fi
expect_reject() { if env "$@" bash "$VERIFIER" "$repo" azure-h5-chile promotions-svc chile-shared deploy false >/dev/null 2>&1; then echo 'FAIL: Chile protection accepted invalid state' >&2; exit 1; fi; }
expect_reject MOCK_BYPASS=true
expect_reject MOCK_REVIEWER_ID=1
expect_reject MOCK_REVIEWER_COUNT=0
expect_reject MOCK_REVIEWER_COUNT=1
expect_reject MOCK_REVIEWER_COUNT=3
expect_reject MOCK_SECOND_REVIEWER_ID=2
expect_reject MOCK_SECOND_REVIEWER_ID=143348512
expect_reject MOCK_REVIEWER_TYPE=Team
expect_reject MOCK_SELF_REVIEW=true
expect_reject MOCK_BRANCHES=master,release
expect_reject MOCK_TYPE=tag
expect_reject MOCK_REQUIRED_REVIEWERS=false
echo 'PASS: insufficient protections fail closed'
bash "$VERIFIER" "$repo" azure-h5-pilot-234 pricing-svc brazil-isolated deploy true >/dev/null
for service in all catalog-svc api-gateway; do
  if bash "$VERIFIER" "$repo" azure-h5-pilot-234 "$service" brazil-isolated deploy true >/dev/null 2>&1; then echo 'FAIL: pilot exception scope broadened' >&2; exit 1; fi
done
if bash "$VERIFIER" "$repo" azure-h5-chile promotions-svc chile-shared deploy true >/dev/null 2>&1; then echo 'FAIL: Chile pilot self review accepted' >&2; exit 1; fi
if bash "$VERIFIER" "$repo" azure-h5-chile promotions-svc brazil-isolated deploy false >/dev/null 2>&1; then echo 'FAIL: Chile approval policy was accepted for Brazil' >&2; exit 1; fi
if env MOCK_SELF_REVIEW=false MOCK_REVIEWER_ID=143348512 bash "$VERIFIER" "$repo" azure-h5 promotions-svc brazil-isolated deploy false >/dev/null 2>&1; then echo 'FAIL: Chile approval policy was accepted by Brazil validator' >&2; exit 1; fi
echo 'PASS: pilot exception remains limited to historical Pricing/Audit behavior'
