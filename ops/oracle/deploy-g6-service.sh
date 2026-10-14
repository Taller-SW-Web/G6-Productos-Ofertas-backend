#!/usr/bin/env bash
set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=service-registry.sh
source "${SCRIPT_DIR}/service-registry.sh"

readonly G6_DEPLOY_EXECUTOR_VERSION=3
readonly G6_SUPPORTED_SERVICE_REGISTRY_VERSION=2

fail() {
  printf 'G6 deployment: %s\n' "$1" >&2
  exit 1
}
G6_SERVICE_REGISTRY_VERSION="$(g6_service_registry_version)" || fail 'versión del registro ausente o inválida'
readonly G6_SERVICE_REGISTRY_VERSION

if [[ "${1:-}" == --version && $# == 1 && -z "${SSH_ORIGINAL_COMMAND:-}" ]]; then
  [[ "$G6_SERVICE_REGISTRY_VERSION" == "$G6_SUPPORTED_SERVICE_REGISTRY_VERSION" ]] ||
    fail 'versiones incompatibles de ejecutor y registro'
  printf 'ejecutor=%s registro=%s\n' "$G6_DEPLOY_EXECUTOR_VERSION" "$G6_SERVICE_REGISTRY_VERSION"
  exit 0
fi
[[ $# == 0 ]] || fail 'argumentos locales no autorizados'
[[ "$G6_SERVICE_REGISTRY_VERSION" == "$G6_SUPPORTED_SERVICE_REGISTRY_VERSION" ]] ||
  fail 'versiones incompatibles de ejecutor y registro'

readonly LEGACY_INVENTORY_RE='^inventory-deploy ([0-9a-f]{40})$'
readonly GENERIC_DEPLOY_RE='^service-deploy ([a-z][a-z0-9-]{0,31}) ([0-9a-f]{40})$'
SERVICE_NAME=''
IMAGE_SHA=''

if [[ "${SSH_ORIGINAL_COMMAND:-}" =~ $LEGACY_INVENTORY_RE ]]; then
  SERVICE_NAME=inventory-svc
  IMAGE_SHA="${BASH_REMATCH[1]}"
elif [[ "${SSH_ORIGINAL_COMMAND:-}" =~ $GENERIC_DEPLOY_RE ]]; then
  SERVICE_NAME="${BASH_REMATCH[1]}"
  IMAGE_SHA="${BASH_REMATCH[2]}"
else
  fail 'comando remoto no autorizado'
fi

g6_service_config "$SERVICE_NAME" || fail 'servicio no autorizado'
[[ "$G6_SERVICE_ENABLED" == true ]] || fail 'servicio registrado pero no habilitado para despliegue'
[[ "$IMAGE_SHA" =~ ^[0-9a-f]{40}$ ]] || fail 'SHA inválido'

IFS= read -r GHCR_USERNAME || fail 'falta usuario GHCR en stdin'
IFS= read -r GHCR_TOKEN || fail 'falta token GHCR en stdin'
[[ -n "$GHCR_USERNAME" && -n "$GHCR_TOKEN" ]] || fail 'credenciales GHCR vacías'

if [[ "$SERVICE_NAME" == inventory-svc ]]; then
  readonly RUNTIME_ENV_FILE="$G6_SERVICE_ENV_FILE"
  [[ -f "$G6_SERVICE_COMPOSE_FILE" ]] || fail "no existe ${G6_SERVICE_COMPOSE_FILE}"
  [[ -r "$RUNTIME_ENV_FILE" ]] || fail "no se puede leer ${RUNTIME_ENV_FILE}"
  grep -Eq "^[[:space:]]*DATABASE_URL[[:space:]]*=[[:space:]]*('[^']+'|\"[^\"]+\"|[^[:space:]#'\"]+)" "$RUNTIME_ENV_FILE" ||
    fail "DATABASE_URL no está definido en ${RUNTIME_ENV_FILE}"
else
  [[ -f "$G6_SERVICE_COMPOSE_FILE" ]] || fail "no existe ${G6_SERVICE_COMPOSE_FILE}"
  [[ -f "$G6_SERVICE_ENV_FILE" && -r "$G6_SERVICE_ENV_FILE" ]] ||
    fail "no se puede leer la configuración privada ${G6_SERVICE_ENV_FILE}"
fi

mkdir -p "$G6_SERVICE_STATE_DIR"
chmod 700 "$G6_SERVICE_STATE_DIR"
command -v flock >/dev/null 2>&1 || fail 'flock no está disponible; no se puede garantizar exclusión por servicio'
exec {SERVICE_LOCK_FD}>"${G6_SERVICE_STATE_DIR}/deploy.lock" ||
  fail 'no se pudo abrir el bloqueo del servicio'
flock -w 600 "$SERVICE_LOCK_FD" || fail 'tiempo de espera agotado para el bloqueo del servicio'
readonly ACTIVE_FILE="${G6_SERVICE_STATE_DIR}/active-image"
readonly PREVIOUS_FILE="${G6_SERVICE_STATE_DIR}/previous-image"
readonly REGISTRY_IMAGE="ghcr.io/taller-sw-web/g6-productos-ofertas-backend/${G6_SERVICE_IMAGE_NAME}"
readonly NEW_IMAGE="${REGISTRY_IMAGE}:${IMAGE_SHA}"
readonly CURRENT_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$G6_SERVICE_CONTAINER" 2>/dev/null || true)"
if [[ -n "$CURRENT_IMAGE" ]]; then
  readonly CURRENT_PREFIX="${REGISTRY_IMAGE}:"
  [[ "$CURRENT_IMAGE" == "$CURRENT_PREFIX"* ]] ||
    fail 'la imagen actual no pertenece al servicio registrado; se conserva sin cambios'
  readonly CURRENT_SHA="${CURRENT_IMAGE#"$CURRENT_PREFIX"}"
  [[ "$CURRENT_SHA" =~ ^[0-9a-f]{40}$ ]] ||
    fail 'la etiqueta actual no es un SHA Git de 40 caracteres; se conserva sin cambios'
fi

export DOCKER_CONFIG
DOCKER_CONFIG="$(mktemp -d)"
trap 'rm -rf "$DOCKER_CONFIG"' EXIT
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io --username "$GHCR_USERNAME" --password-stdin
unset GHCR_TOKEN

compose() {
  local image="$1"
  shift
  if [[ "$SERVICE_NAME" == inventory-svc ]]; then
    env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
      DOCKER_CONFIG="$DOCKER_CONFIG" INVENTORY_IMAGE="$image" \
      docker compose --file "$G6_SERVICE_COMPOSE_FILE" --project-name "$G6_SERVICE_COMPOSE_PROJECT" "$@" "$G6_SERVICE_COMPOSE_UNIT"
  else
    env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
      DOCKER_CONFIG="$DOCKER_CONFIG" G6_SERVICE_IMAGE="$image" \
      G6_SERVICE_PORT="$G6_SERVICE_PORT" G6_SERVICE_PORT_ENV="$G6_SERVICE_PORT_ENV" \
      G6_SERVICE_CONTAINER="$G6_SERVICE_CONTAINER" \
      G6_SERVICE_ENV_FILE="$G6_SERVICE_ENV_FILE" \
      docker compose --file "$G6_SERVICE_COMPOSE_FILE" --project-name "$G6_SERVICE_COMPOSE_PROJECT" "$@" "$G6_SERVICE_COMPOSE_UNIT"
  fi
}

container_matches_image_and_is_healthy() {
  local expected_image="$1"
  local actual_image health_status
  actual_image="$(docker inspect --format '{{.Config.Image}}' "$G6_SERVICE_CONTAINER" 2>/dev/null)" || return 1
  [[ "$actual_image" == "$expected_image" ]] || return 1
  health_status="$(docker inspect --format '{{.State.Health.Status}}' "$G6_SERVICE_CONTAINER" 2>/dev/null)" || return 1
  [[ "$health_status" == healthy ]]
}

service_is_healthy() {
  local expected_image="$1"
  container_matches_image_and_is_healthy "$expected_image" &&
    curl --fail --silent "http://127.0.0.1:${G6_SERVICE_PORT}/health" >/dev/null
}

if [[ -n "$CURRENT_IMAGE" ]]; then
  printf '%s\n' "$CURRENT_IMAGE" > "${PREVIOUS_FILE}.tmp"
  mv "${PREVIOUS_FILE}.tmp" "$PREVIOUS_FILE"
fi

if ! compose "$NEW_IMAGE" pull; then
  fail 'pull de la nueva imagen falló; la instancia actual sigue activa'
fi

if ! compose "$NEW_IMAGE" up --detach --no-deps; then
  if [[ -n "$CURRENT_IMAGE" ]] && compose "$CURRENT_IMAGE" up --detach --no-deps; then
    for attempt in {1..30}; do
      if service_is_healthy "$CURRENT_IMAGE"; then
        printf '%s\n' "$CURRENT_IMAGE" > "${ACTIVE_FILE}.tmp"
        mv "${ACTIVE_FILE}.tmp" "$ACTIVE_FILE"
        fail "arranque de nueva imagen falló; restaurada ${CURRENT_IMAGE}"
      fi
      sleep 2
    done
  fi
  if [[ -z "$CURRENT_IMAGE" ]]; then
    compose "$NEW_IMAGE" rm --stop --force
  fi
  fail 'arranque de la nueva imagen falló y el rollback no pudo verificarse'
fi

healthy=false
for attempt in {1..30}; do
  if service_is_healthy "$NEW_IMAGE"; then
    healthy=true
    break
  fi
  sleep 2
done

if [[ "$healthy" != true ]]; then
  printf 'G6 deployment: health check falló para %s; iniciando rollback\n' "$NEW_IMAGE" >&2
  if [[ -n "$CURRENT_IMAGE" ]]; then
    if compose "$CURRENT_IMAGE" up --detach --no-deps; then
      for attempt in {1..30}; do
        if service_is_healthy "$CURRENT_IMAGE"; then
          printf '%s\n' "$CURRENT_IMAGE" > "${ACTIVE_FILE}.tmp"
          mv "${ACTIVE_FILE}.tmp" "$ACTIVE_FILE"
          fail "nueva imagen no saludable; restaurada ${CURRENT_IMAGE}"
        fi
        sleep 2
      done
    fi
    fail "health check falló y el rollback a ${CURRENT_IMAGE} no se pudo verificar"
  fi
  compose "$NEW_IMAGE" rm --stop --force
  rm -f "$ACTIVE_FILE"
  fail 'health check falló; no había una versión anterior que restaurar'
fi

printf '%s\n' "$NEW_IMAGE" > "${ACTIVE_FILE}.tmp"
mv "${ACTIVE_FILE}.tmp" "$ACTIVE_FILE"
printf 'G6 deployment: %s activo %s; anterior registrado en %s\n' "$SERVICE_NAME" "$NEW_IMAGE" "$PREVIOUS_FILE"
