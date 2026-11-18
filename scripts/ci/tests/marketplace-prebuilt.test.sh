#!/usr/bin/env bash
set -Eeuo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="$root/scripts/ci/marketplace-docker.sh"
scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"' EXIT
mkdir "$scratch/bin"
cat > "$scratch/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >> "$MOCK_DOCKER_LOG"
[[ "$1 $2" == 'image inspect' ]]
[[ "${3:-}" == "${AVAILABLE_IMAGE:-}" ]]
MOCK
chmod +x "$scratch/bin/docker"

run_expect_missing() {
  local available="$1" missing="$2" expected_calls="$3" code=0 output
  : > "$scratch/docker.log"
  set +e
  output="$(PATH="$scratch/bin:$PATH" MOCK_DOCKER_LOG="$scratch/docker.log" AVAILABLE_IMAGE="$available" \
    G6_MARKETPLACE_USE_PREBUILT=true bash "$script" 2>&1)"
  code=$?
  set -e
  [[ "$code" -ne 0 ]] || { printf 'FALLO: se aceptó la falta de %s.\n' "$missing" >&2; return 1; }
  [[ "$output" == *"requiere la imagen local $missing; no se reconstruirá."* ]] || {
    printf 'FALLO: mensaje inesperado para %s: %s\n' "$missing" "$output" >&2
    return 1
  }
  [[ "$(wc -l < "$scratch/docker.log")" -eq "$expected_calls" ]] || {
    printf 'FALLO: el escenario avanzó después de faltar %s.\n' "$missing" >&2
    cat "$scratch/docker.log" >&2
    return 1
  }
  ! grep -Eq 'network create| run | compose|exec ' "$scratch/docker.log"
}

run_expect_missing '' 'g6-service:catalog-svc-ci' 1
run_expect_missing 'g6-service:catalog-svc-ci' 'g6-service:taxonomy-svc-ci' 2
printf 'PASS: el modo preconstruido rechaza cada imagen ausente antes de iniciar recursos o reconstruir.\n'
