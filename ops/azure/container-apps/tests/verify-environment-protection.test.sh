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
  *'deployment-branch-policies'*) printf '{"branch_policies":[{"name":"%s","type":"%s"}]}' "${MOCK_BRANCH:-master}" "${MOCK_TYPE:-branch}" ;;
  *'azure-h5-pilot-234'*) printf '{"deployment_branch_policy":{"custom_branch_policies":true,"protected_branches":false},"protection_rules":[{"type":"required_reviewers","prevent_self_review":false,"reviewers":[{"type":"User","reviewer":{"id":129343979}}]}]}' ;;
  *'/environments/'*) [[ "${MOCK_ENV_EXISTS:-true}" == true ]] || exit 1; printf '{"can_admins_bypass":%s,"protection_rules":[{"type":"required_reviewers","prevent_self_review":%s,"reviewers":[{"type":"User","reviewer":{"id":1}}]}],"deployment_branch_policy":{"custom_branch_policies":true,"protected_branches":false}}' "${MOCK_BYPASS:-false}" "${MOCK_SELF_REVIEW:-true}" ;;
  *) exit 41 ;;
esac
MOCK
chmod +x "$TEMP/bin/gh"
export PATH="$TEMP/bin:$PATH" GH_TOKEN=fixture
export GH_CALL_LOG="$TEMP/gh-calls.log"
repo=Taller-SW-Web/G6-Productos-Ofertas-backend
bash "$VERIFIER" "$repo" >/dev/null
bash "$VERIFIER" "$repo" azure-h5-chile catalog-svc chile-shared deploy false >/dev/null
MOCK_ENABLED=False bash "$VERIFIER" "$repo" azure-h5-chile catalog-svc chile-shared recovery false >/dev/null
echo 'PASS: strict Brazil and Chile protection checks are independent from the job-scoped deploy gate'
if grep -Fq '/variables/AZURE_CHILE_DEPLOY_ENABLED' "$GH_CALL_LOG"; then echo 'FAIL: variable REST endpoint was queried by protection verifier' >&2; exit 1; fi
expect_reject() { if env "$@" bash "$VERIFIER" "$repo" azure-h5-chile catalog-svc chile-shared deploy false >/dev/null 2>&1; then echo 'FAIL: Chile protection accepted invalid state' >&2; exit 1; fi; }
expect_reject MOCK_BYPASS=true
expect_reject MOCK_SELF_REVIEW=false
expect_reject MOCK_BRANCH=master,release
expect_reject MOCK_TYPE=tag
echo 'PASS: insufficient protections fail closed'
bash "$VERIFIER" "$repo" azure-h5-pilot-234 pricing-svc brazil-isolated deploy true >/dev/null
for service in all catalog-svc api-gateway; do
  if bash "$VERIFIER" "$repo" azure-h5-pilot-234 "$service" brazil-isolated deploy true >/dev/null 2>&1; then echo 'FAIL: pilot exception scope broadened' >&2; exit 1; fi
done
if bash "$VERIFIER" "$repo" azure-h5-chile catalog-svc chile-shared deploy true >/dev/null 2>&1; then echo 'FAIL: Chile pilot self review accepted' >&2; exit 1; fi
echo 'PASS: pilot exception remains limited to historical Pricing/Audit behavior'
