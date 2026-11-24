#!/usr/bin/env bash
set -Eeuo pipefail

fail() { printf 'PREFLIGHT FAIL: %s\n' "$1" >&2; exit 1; }
repo='https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend.git'
ref="${H5_PREFLIGHT_REF:-master}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

[[ "$(uname -m)" == x86_64 ]] || fail "arquitectura no compatible con el runner X64: $(uname -m)"
[[ -x /home/runner/run.sh ]] || fail 'la imagen no contiene /home/runner/run.sh ejecutable'

for tool in bash curl getent grep git jq node openssl timeout; do
  command -v "$tool" >/dev/null 2>&1 || fail "falta dependencia requerida: $tool"
done
printf 'PASS imagen/arquitectura/dependencias: x86_64; runner y prerrequisitos Git/Node para checkout disponibles\n'

git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$ref" "$repo" "$work/backend" || fail 'git clone HTTPS del repositorio falló'
cd "$work/backend"
[[ -f ops/azure/container-apps/smoke-service.sh ]] || fail 'checkout no contiene smoke-service.sh'
[[ -f ops/azure/github-runner-h5/probe-private-endpoint.sh ]] || fail 'checkout no contiene el probe TLS'

for host in github.com api.github.com raw.githubusercontent.com codeload.github.com ghcr.io; do
  bash ops/azure/github-runner-h5/probe-private-endpoint.sh "https://${host}"
done

# Demonstrate the real smoke script starts and fails closed before HTTP when
# its target variables are intentionally absent. This is not an HTTP smoke.
set +e
smoke_output="$(env -u SMOKE_URL -u SMOKE_PROTECTED_PATH bash ops/azure/container-apps/smoke-service.sh catalog-svc 2>&1)"
smoke_status=$?
set -e
[[ "$smoke_status" != 0 ]] || fail 'smoke-service.sh should fail closed without a target URL'
[[ "$smoke_output" == *'BLOQUEADO: falta AZURE_SMOKE_URL_CATALOG_SVC'* ]] || fail 'smoke-service.sh did not report the expected closed gate'
printf 'PASS checkout/script: Git cloned %s and smoke-service.sh failed closed without issuing HTTP\n' "$ref"
printf 'PREFLIGHT PASS: container image can run Git transport and smoke prerequisites; actions/checkout itself was not executed; no Docker command used\n'
