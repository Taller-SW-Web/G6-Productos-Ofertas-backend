#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
WORKFLOW="$ROOT/.github/workflows/cd-services-azure.yml"
PREFLIGHT="$ROOT/ops/azure/github-runner-h5/preflight-runner-container.sh"

grep -Fq "'on':" "$WORKFLOW" || grep -Eq '^on:' "$WORKFLOW" || { echo 'FAIL: workflow triggers absent' >&2; exit 1; }
grep -Fq 'workflow_dispatch:' "$WORKFLOW" || { echo 'FAIL: CD must be manual only' >&2; exit 1; }
if grep -Eq '^[[:space:]]+pull_request(_target)?:' "$WORKFLOW"; then
  echo 'FAIL: CD cannot trigger from pull requests' >&2; exit 1
fi
grep -Fq 'runs-on: [self-hosted, linux, "${{ needs.prepare.outputs.runner_label }}"]' "$WORKFLOW" || { echo 'FAIL: smoke runner label must come from the verified destination map' >&2; exit 1; }
grep -Fq '"smokeLabel": "azure-h5-smoke"' "$ROOT/ops/azure/container-apps/deployment-targets.json" || { echo 'FAIL: Brazil runner label mapping changed' >&2; exit 1; }
grep -Fq '"smokeLabel": "azure-h5-smoke-chile"' "$ROOT/ops/azure/container-apps/deployment-targets.json" || { echo 'FAIL: Chile runner label mapping changed' >&2; exit 1; }
grep -Fq 'uses: actions/checkout@v4' "$WORKFLOW" || { echo 'FAIL: smoke job no longer checks out code' >&2; exit 1; }

smoke_section="$(sed -n '/^  smoke:/,/^  recover:/p' "$WORKFLOW")"
[[ -n "$smoke_section" ]] || { echo 'FAIL: could not isolate smoke job' >&2; exit 1; }
[[ "$smoke_section" == *'environment:'* ]] || { echo 'FAIL: smoke job lacks protected environment' >&2; exit 1; }
if grep -Eq '(^|[[:space:]])container:|docker([[:space:]]|$)' <<< "$smoke_section"; then
  echo 'FAIL: smoke job unexpectedly depends on Docker' >&2; exit 1
fi
if grep -Eq '(^|[[:space:]])docker([[:space:]]|$)' "$PREFLIGHT"; then
  echo 'FAIL: container preflight unexpectedly invokes Docker' >&2; exit 1
fi
echo 'PASS: manual CD only, protected smoke environment, fixed runner labels, checkout present, no PR trigger or Docker dependency'
