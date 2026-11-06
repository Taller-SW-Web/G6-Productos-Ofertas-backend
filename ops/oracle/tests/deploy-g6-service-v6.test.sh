#!/usr/bin/env bash
set -Eeuo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
readonly TEMP_ROOT="$(mktemp -d)"
readonly STAGE="$TEMP_ROOT/opt/g6-productos-ofertas"
readonly MOCK_BIN="$TEMP_ROOT/bin"
readonly STATE="$TEMP_ROOT/state"
readonly OLD_IMAGE='ghcr.io/taller-sw-web/g6-productos-ofertas-backend/bulk-svc:1111111111111111111111111111111111111111'
readonly NEXT_SHA='2222222222222222222222222222222222222222'
readonly ROLLBACK_SHA='3333333333333333333333333333333333333333'
readonly OPTOUT_SHA='4444444444444444444444444444444444444444'
readonly GATEWAY_IMAGE='ghcr.io/taller-sw-web/g6-productos-ofertas-backend/api-gateway:5555555555555555555555555555555555555555'
trap 'rm -rf "$TEMP_ROOT"' EXIT
mkdir -p "$STAGE/shared" "$STAGE/api-gateway" "$TEMP_ROOT/lib" "$TEMP_ROOT/etc/g6-bulk-svc" "$TEMP_ROOT/etc/g6-api-gateway" "$TEMP_ROOT/var/lib/g6-productos-ofertas/bulk-svc" "$TEMP_ROOT/var/lib/g6-productos-ofertas/api-gateway" "$MOCK_BIN" "$STATE"
cp "$ROOT/ops/oracle/deploy-g6-service-v6.sh" "$ROOT/ops/oracle/amqp-opt-in.sh" \
  "$ROOT/ops/oracle/service-registry.sh" "$ROOT/ops/oracle/services.psv" "$TEMP_ROOT/lib/"
cp "$ROOT/ops/oracle/docker-compose.service.yml" "$STAGE/shared/docker-compose.service.yml"
cp "$ROOT/ops/oracle/docker-compose.service.http.yml" "$STAGE/shared/docker-compose.service.http.yml"
cp "$ROOT/ops/oracle/docker-compose.service.amqp.yml" "$STAGE/shared/docker-compose.service.amqp.yml"
cp "$ROOT/ops/oracle/docker-compose.gateway.yml" "$STAGE/api-gateway/docker-compose.gateway.yml"
sed -i \
  -e "s|/opt/g6-productos-ofertas|$TEMP_ROOT/opt/g6-productos-ofertas|g" \
  -e "s|/var/lib/g6-productos-ofertas|$TEMP_ROOT/var/lib/g6-productos-ofertas|g" \
  -e "s|/etc/g6-|$TEMP_ROOT/etc/g6-|g" \
  "$TEMP_ROOT/lib/service-registry.sh" "$TEMP_ROOT/lib/services.psv"
sed -i \
  -e "s|/etc/g6-productos-ofertas/amqp-opt-in.psv|$TEMP_ROOT/etc/amqp-opt-in.psv|g" \
  -e "s|/opt/g6-productos-ofertas/shared/docker-compose.service.amqp.yml|$STAGE/shared/docker-compose.service.amqp.yml|g" \
  -e "s|/opt/g6-productos-ofertas/inventory/docker-compose.inventory.amqp.yml|$STAGE/inventory/docker-compose.inventory.amqp.yml|g" \
  -e "s|/opt/g6-productos-ofertas/shared/docker-compose.service.http.yml|$STAGE/shared/docker-compose.service.http.yml|g" \
  -e "s|/opt/g6-productos-ofertas/inventory/docker-compose.inventory.http.yml|$STAGE/inventory/docker-compose.inventory.http.yml|g" \
  -e 's/sleep 2/: # pausa omitida en fixture/' \
  -e "s|PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin|PATH=$MOCK_BIN:/usr/bin:/bin MOCK_ROOT=$STATE|g" \
  "$TEMP_ROOT/lib/deploy-g6-service-v6.sh"
sed -i \
  -e "s|/etc/g6-productos-ofertas/amqp-opt-in.psv|$TEMP_ROOT/etc/amqp-opt-in.psv|g" \
  -e "s|/opt/g6-productos-ofertas/shared/docker-compose.service.amqp.yml|$STAGE/shared/docker-compose.service.amqp.yml|g" \
  -e "s|/opt/g6-productos-ofertas/inventory/docker-compose.inventory.amqp.yml|$STAGE/inventory/docker-compose.inventory.amqp.yml|g" \
  "$TEMP_ROOT/lib/amqp-opt-in.sh"
printf '%s\n' 'BULK_AMQP_URL=amqp://fixture:fixture@rabbitmq:5672/g6-productos-ofertas' > "$TEMP_ROOT/etc/g6-bulk-svc/runtime.env"
printf '%s\n' 'PORT=3000' > "$TEMP_ROOT/etc/g6-api-gateway/runtime.env"
chmod 640 "$TEMP_ROOT/etc/g6-bulk-svc/runtime.env"
chmod 640 "$TEMP_ROOT/etc/g6-api-gateway/runtime.env"
printf '%s\n' "$OLD_IMAGE" > "$STATE/current-image"
printf 'false\n' > "$STATE/amqp-profile"
printf '%s\n' "${OLD_IMAGE##*:}" > "$STATE/old-sha"

cat > "$MOCK_BIN/stat" <<'MOCK_STAT'
#!/usr/bin/env bash
if [[ "${1:-}" == -c && "${2:-}" == '%u:%a' ]]; then printf '0:0640\n'; else exec /usr/bin/stat "$@"; fi
MOCK_STAT
cat > "$MOCK_BIN/docker" <<'MOCK_DOCKER'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >> "$MOCK_ROOT/docker.log"
format=''
container="${!#}"
if [[ "${1:-}" == network && "${2:-}" == inspect ]]; then
  network="${!#}"
  format=''
  while (($#)); do if [[ "$1" == --format ]]; then format="$2"; shift 2; else shift; fi; done
  printf '%s\n' "$network" >> "$MOCK_ROOT/network.log"
  if [[ "$network" == g6-http ]]; then
    if [[ "$format" == *'.Containers'* ]]; then exit 0; fi
    printf 'bridge|local|false|false|false|false|default|1|0\n'
    exit 0
  fi
  case "$format" in
    *'.Containers'*) printf 'g6-po-rabbitmq-1\n' ;;
    *'.Name'*) printf 'g6-po_g6_backend|bridge|local|false|false|false|false|default|1|0\n' ;;
    *) exit 1 ;;
  esac
  exit 0
fi
if [[ "${1:-}" == inspect ]]; then
  format=''; container="${!#}"
  while (($#)); do if [[ "$1" == --format ]]; then format="$2"; shift 2; else shift; fi; done
  case "$format" in
    *'.Config.Image'*) cat "$MOCK_ROOT/current-image" ;;
    *'.State.Health.Status'*)
      current="$(<"$MOCK_ROOT/current-image")"
      if [[ -n "${MOCK_FAIL_IMAGE_SHA:-}" && "$current" == *":$MOCK_FAIL_IMAGE_SHA" ]]; then printf 'unhealthy\n'; else printf 'healthy\n'; fi ;;
    *'if index .NetworkSettings.Networks "g6-po_g6_backend"'*)
      if [[ "${MOCK_PROFILE_UNKNOWN:-false}" == true ]]; then printf 'unknown\n'; else cat "$MOCK_ROOT/amqp-profile"; fi ;;
    *'com.docker.compose.service'*) printf 'rabbitmq|g6-po\n' ;;
    *'NetworkSettings.Networks'*) printf 'rabbitmq\ng6-rabbitmq\ng6-po-rabbitmq-1\n' ;;
    *) exit 1 ;;
  esac
  exit 0
fi
if [[ "${1:-}" == login ]]; then exit 0; fi
if [[ "${1:-}" == compose ]]; then
  printf '%s\n' "$*" >> "$MOCK_ROOT/compose.log"
  case " $* " in
    *' pull '*) exit 0 ;;
    *' up '* )
      requested_image="${G6_SERVICE_IMAGE:-${INVENTORY_IMAGE:-}}"
      if [[ "$requested_image" != *:* ]]; then exit 2; fi
      if [[ -f "$MOCK_ROOT/fail-rollback" && "$requested_image" == *":$(<"$MOCK_ROOT/old-sha")" ]]; then exit 1; fi
      if [[ "$*" == *docker-compose.service.amqp.yml* || "$*" == *docker-compose.inventory.amqp.yml* ]]; then printf 'true\n' > "$MOCK_ROOT/amqp-profile"; else printf 'false\n' > "$MOCK_ROOT/amqp-profile"; fi
      printf '%s\n' "$requested_image" > "$MOCK_ROOT/current-image"
      exit 0 ;;
    *) exit 0 ;;
  esac
fi
printf 'Unexpected mock Docker command\n' >&2
exit 2
MOCK_DOCKER
cat > "$MOCK_BIN/curl" <<'MOCK_CURL'
#!/usr/bin/env bash
exit 0
MOCK_CURL
chmod +x "$MOCK_BIN/stat" "$MOCK_BIN/docker" "$MOCK_BIN/curl" "$TEMP_ROOT/lib/deploy-g6-service-v6.sh"
export MOCK_ROOT="$STATE" MOCK_NETWORK_LOG='inspect g6-po_g6_backend'
export MOCK_OLD_IMAGE_SHA="${OLD_IMAGE##*:}"
export PATH="$MOCK_BIN:$PATH"

run_deploy() {
  local sha="$1" expected="$2" result=0
  : > "$STATE/compose.log"
  : > "$STATE/network.log"
  : > "$STATE/docker.log"
  : > "$STATE/http-network.log"
  if printf '%s\n%s\n' fixture-user fixture-token | env SSH_ORIGINAL_COMMAND="service-deploy bulk-svc $sha" bash "$TEMP_ROOT/lib/deploy-g6-service-v6.sh" >"$STATE/result.log" 2>&1; then result=0; else result=$?; fi
  [[ "$result" == "$expected" ]] || { cat "$STATE/result.log" >&2; printf 'mock current image: %s\n' "$(<"$STATE/current-image")" >&2; cat "$STATE/network.log" >&2; cat "$STATE/docker.log" >&2; cat "$STATE/compose.log" >&2; printf 'unexpected status=%s expected=%s\n' "$result" "$expected" >&2; return 1; }
}

[[ "$(env -u SSH_ORIGINAL_COMMAND bash "$TEMP_ROOT/lib/deploy-g6-service-v6.sh" --version)" == 'ejecutor=6 registro=2' ]] || { printf 'FAIL: v6/registro v2 incompatible\n' >&2; exit 1; }
printf '%s\n' '#manifiesto-corrupto' 'api-gateway' > "$TEMP_ROOT/etc/amqp-opt-in.psv"
chmod 640 "$TEMP_ROOT/etc/amqp-opt-in.psv"
printf '%s\n' "$GATEWAY_IMAGE" > "$STATE/current-image"
gateway_status=0
if printf '%s\n%s\n' fixture-user fixture-token | env SSH_ORIGINAL_COMMAND="service-deploy api-gateway ${GATEWAY_IMAGE##*:}" bash "$TEMP_ROOT/lib/deploy-g6-service-v6.sh" >"$STATE/result.log" 2>&1; then gateway_status=0; else gateway_status=$?; fi
[[ "$gateway_status" == 0 ]] || { cat "$STATE/result.log" >&2; printf 'FAIL: manifiesto AMQP defectuoso bloqueó despliegue HTTP de Gateway\n' >&2; exit 1; }
! grep -Fq 'docker-compose.service.amqp.yml' "$STATE/compose.log" || { printf 'FAIL: Gateway recibió overlay AMQP\n' >&2; exit 1; }
! grep -Fxq g6-po_g6_backend "$STATE/network.log" || { printf 'FAIL: Gateway inspeccionó la red AMQP\n' >&2; exit 1; }
printf 'PASS: Gateway despliega HTTP con manifiesto AMQP alterado, sin overlay ni inspección RabbitMQ\n'
printf '%s\n' '#g6-amqp-opt-in-version=1' > "$TEMP_ROOT/etc/amqp-opt-in.psv"
chmod 640 "$TEMP_ROOT/etc/amqp-opt-in.psv"
printf '%s\n' "$OLD_IMAGE" > "$STATE/current-image"
run_deploy "$NEXT_SHA" 0
! grep -Fq 'docker-compose.service.amqp.yml' "$STATE/compose.log" || { printf 'FAIL: AMQP overlay applied without selector\n' >&2; exit 1; }
! grep -Fxq g6-po_g6_backend "$STATE/network.log" || { printf 'FAIL: red AMQP inspeccionada sin opt-in\n' >&2; exit 1; }
printf 'PASS: despliegue v6 sin selección conserva flujo previo y no inspecciona RabbitMQ\n'

printf '%s\n' '#g6-amqp-opt-in-version=1' 'bulk-svc' > "$TEMP_ROOT/etc/amqp-opt-in.psv"
chmod 640 "$TEMP_ROOT/etc/amqp-opt-in.psv"
printf '%s\n' "$OLD_IMAGE" > "$STATE/current-image"
run_deploy "$NEXT_SHA" 0
grep -Fq 'docker-compose.service.amqp.yml' "$STATE/compose.log" || { printf 'FAIL: opt-in no aplicó overlay\n' >&2; exit 1; }
grep -Fxq g6-po_g6_backend "$STATE/network.log" || { printf 'FAIL: opt-in no prevalidó la red\n' >&2; exit 1; }
printf 'PASS: activación mixta aplica overlay solo al servicio seleccionado\n'

export MOCK_FAIL_NEW=true
export MOCK_FAIL_IMAGE_SHA="$ROLLBACK_SHA"
printf '%s\n' "$OLD_IMAGE" > "$STATE/current-image"
printf 'true\n' > "$STATE/amqp-profile"
run_deploy "$ROLLBACK_SHA" 1
[[ "$(grep -c 'docker-compose.service.amqp.yml.* up ' "$STATE/compose.log")" == 2 ]] || { printf 'FAIL: rollback opt-in no conservó overlay seleccionado\n' >&2; exit 1; }
[[ "$(<"$STATE/current-image")" == "$OLD_IMAGE" ]] || { printf 'FAIL: rollback opt-in no restauró imagen anterior\n' >&2; exit 1; }
[[ "$(<"$STATE/amqp-profile")" == true ]] || { printf 'FAIL: perfil AMQP anterior opt-in no fue restaurado\n' >&2; exit 1; }
printf 'PASS: rollback fallido hacia perfil opt-in repone imagen y perfil previos\n'
unset MOCK_FAIL_NEW MOCK_FAIL_IMAGE_SHA

printf '%s\n' '#g6-amqp-opt-in-version=1' 'bulk-svc' > "$TEMP_ROOT/etc/amqp-opt-in.psv"
printf '%s\n' "$OLD_IMAGE" > "$STATE/current-image"
printf 'false\n' > "$STATE/amqp-profile"
export MOCK_FAIL_IMAGE_SHA="$ROLLBACK_SHA"
run_deploy "$ROLLBACK_SHA" 1
[[ "$(grep -c 'docker-compose.service.amqp.yml.* up ' "$STATE/compose.log" || true)" == 1 ]] || { printf 'FAIL: rollback de activación fallida no conservó perfil HTTP anterior\n' >&2; exit 1; }
[[ "$(<"$STATE/amqp-profile")" == false ]] || { printf 'FAIL: activación fallida dejó perfil AMQP activo\n' >&2; exit 1; }
printf 'PASS: activación fallida desde HTTP revierte a la imagen y perfil HTTP anteriores\n'
unset MOCK_FAIL_IMAGE_SHA

printf '%s\n' '#g6-amqp-opt-in-version=1' 'combos-svc' > "$TEMP_ROOT/etc/amqp-opt-in.psv"
printf '%s\n' "$OLD_IMAGE" > "$STATE/current-image"
printf 'true\n' > "$STATE/amqp-profile"
export MOCK_FAIL_IMAGE_SHA="$ROLLBACK_SHA"
run_deploy "$ROLLBACK_SHA" 1
[[ "$(grep -c 'docker-compose.service.amqp.yml.* up ' "$STATE/compose.log")" == 1 ]] || { printf 'FAIL: rollback de desactivación no recuperó perfil AMQP anterior\n' >&2; exit 1; }
[[ "$(<"$STATE/amqp-profile")" == true ]] || { printf 'FAIL: rollback no restauró el perfil AMQP previo\n' >&2; exit 1; }
printf 'PASS: opt-out fallido recupera el perfil AMQP que tenía la imagen anterior\n'
unset MOCK_FAIL_IMAGE_SHA

printf '%s\n' '#g6-amqp-opt-in-version=1' 'combos-svc' > "$TEMP_ROOT/etc/amqp-opt-in.psv"
printf '%s\n' "$OLD_IMAGE" > "$STATE/current-image"
printf 'true\n' > "$STATE/amqp-profile"
export MOCK_FAIL_IMAGE_SHA="$ROLLBACK_SHA"
touch "$STATE/fail-rollback"
run_deploy "$ROLLBACK_SHA" 1
if grep -Fq 'restaurada ' "$STATE/result.log"; then printf 'FAIL: rollback no verificado afirmó restauración completa\n' >&2; exit 1; fi
[[ "$(<"$STATE/current-image")" == *":$ROLLBACK_SHA" ]] || { printf 'FAIL: fixture no reprodujo rollback de imagen fallido\n' >&2; exit 1; }
printf 'PASS: rollback Compose fallido se detiene sin afirmar restauración completa\n'
unset MOCK_FAIL_IMAGE_SHA
rm -f "$STATE/fail-rollback"

printf '%s\n' '#g6-amqp-opt-in-version=1' 'combos-svc' > "$TEMP_ROOT/etc/amqp-opt-in.psv"
printf '%s\n' "$OLD_IMAGE" > "$STATE/current-image"
printf 'true\n' > "$STATE/amqp-profile"
run_deploy "$OPTOUT_SHA" 0
! grep -Fq 'docker-compose.service.amqp.yml' "$STATE/compose.log" || { printf 'FAIL: opt-out conservó overlay\n' >&2; exit 1; }
grep -Fxq g6-po_g6_backend "$STATE/network.log" || { printf 'FAIL: opt-out no verificó el perfil anterior que debe restaurar ante fallo\n' >&2; exit 1; }
[[ "$(<"$STATE/amqp-profile")" == false ]] || { printf 'FAIL: opt-out no eliminó perfil AMQP simulado\n' >&2; exit 1; }
printf 'PASS: opt-out cambia a perfil HTTP sin requerir inspección AMQP\n'

printf '%s\n' "$OLD_IMAGE" > "$STATE/current-image"
printf 'false\n' > "$STATE/amqp-profile"
export MOCK_PROFILE_UNKNOWN=true
run_deploy "$NEXT_SHA" 1
[[ "$(<"$STATE/current-image")" == "$OLD_IMAGE" ]] || { printf 'FAIL: perfil previo indeterminado permitió mutar imagen\n' >&2; exit 1; }
! grep -Fq ' up ' "$STATE/compose.log" || { printf 'FAIL: perfil previo indeterminado permitió recreación\n' >&2; exit 1; }
printf 'PASS: perfil de red previo indeterminado aborta antes de modificar el servicio\n'
unset MOCK_PROFILE_UNKNOWN
