#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
RESOLVER="$ROOT/ops/azure/container-apps/resolve-deployment-target.sh"
assert_target() { local json; json="$(bash "$RESOLVER" "$1" "$2" "$3")"; jq -e --arg rg "$4" --arg env "$5" --arg gh "$6" '.resourceGroup==$rg and .acaEnvironment==$env and .githubEnvironment==$gh' <<< "$json" >/dev/null; }
assert_target chile-shared false catalog-svc rg-g6-aca-chile env-g6-phase1-chile azure-h5-chile
assert_target brazil-isolated false all rg-g6-sb-h5-int-fork env-g6-h5-int azure-h5
assert_target brazil-isolated true pricing-svc rg-g6-aca-chile env-g6-phase1-chile azure-h5-pilot-234
for args in 'invalid false catalog-svc' 'chile-shared true pricing-svc' 'chile-shared false all' 'brazil-isolated true catalog-svc'; do
  if bash "$RESOLVER" $args >/dev/null 2>&1; then echo "FAIL: rejected destination combination accepted: $args" >&2; exit 1; fi
done
echo 'PASS: explicit destination maps, legacy Brazil/pilot compatibility, invalid/Chile pilot/all rejected'
