#!/usr/bin/env bash
set -Eeuo pipefail

readonly DEPLOY_DIR="/opt/g6-productos-ofertas/inventory"
readonly COMPOSE_FILE="${DEPLOY_DIR}/docker-compose.inventory.yml"
readonly RUNTIME_ENV_FILE="/etc/g6-inventory/runtime.env"
readonly STATE_DIR="/var/lib/g6-inventory"
readonly ACTIVE_FILE="${STATE_DIR}/active-image"
readonly PREVIOUS_FILE="${STATE_DIR}/previous-image"
readonly REGISTRY_IMAGE="ghcr.io/taller-sw-web/g6-productos-ofertas-backend/inventory-svc"

fail() {
  printf 'inventory deployment: %s\n' "$1" >&2
  exit 1
}

[[ "${SSH_ORIGINAL_COMMAND:-}" =~ ^inventory-deploy\ ([0-9a-f]{40})$ ]] || fail 'comando remoto no autorizado'
readonly IMAGE_SHA="${BASH_REMATCH[1]}"
IFS= read -r GHCR_USERNAME || fail 'falta usuario GHCR en stdin'
IFS= read -r GHCR_TOKEN || fail 'falta token GHCR en stdin'
[[ -n "$GHCR_USERNAME" && -n "$GHCR_TOKEN" ]] || fail 'credenciales GHCR vacías'

[[ -f "$COMPOSE_FILE" ]] || fail "no existe ${COMPOSE_FILE}"
[[ -r "$RUNTIME_ENV_FILE" ]] || fail "no se puede leer ${RUNTIME_ENV_FILE}"
grep -Eq "^[[:space:]]*DATABASE_URL[[:space:]]*=[[:space:]]*('[^']+'|\"[^\"]+\"|[^[:space:]#'\"]+)" "$RUNTIME_ENV_FILE" ||
  fail "DATABASE_URL no está definido en ${RUNTIME_ENV_FILE}"
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

export DOCKER_CONFIG
DOCKER_CONFIG="$(mktemp -d)"
trap 'rm -rf "$DOCKER_CONFIG"' EXIT
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io --username "$GHCR_USERNAME" --password-stdin
unset GHCR_TOKEN

readonly NEW_IMAGE="${REGISTRY_IMAGE}:${IMAGE_SHA}"
readonly CURRENT_IMAGE="$(docker inspect --format '{{.Config.Image}}' g6-inventory-svc 2>/dev/null || true)"

if [[ -n "$CURRENT_IMAGE" ]]; then
  printf '%s\n' "$CURRENT_IMAGE" > "${PREVIOUS_FILE}.tmp"
  mv "${PREVIOUS_FILE}.tmp" "$PREVIOUS_FILE"
fi

compose() {
  local image="$1"
  shift
  INVENTORY_IMAGE="$image" docker compose --file "$COMPOSE_FILE" --project-name g6-inventory "$@"
}

container_matches_image_and_is_healthy() {
  local expected_image="$1"
  local actual_image health_status
  actual_image="$(docker inspect --format '{{.Config.Image}}' g6-inventory-svc 2>/dev/null)" || return 1
  [[ "$actual_image" == "$expected_image" ]] || return 1
  health_status="$(docker inspect --format '{{.State.Health.Status}}' g6-inventory-svc 2>/dev/null)" || return 1
  [[ "$health_status" == healthy ]]
}

service_is_healthy() {
  local expected_image="$1"
  container_matches_image_and_is_healthy "$expected_image" &&
    curl --fail --silent http://127.0.0.1:3005/health >/dev/null
}

if ! compose "$NEW_IMAGE" pull; then
  fail 'pull de la nueva imagen falló; la instancia actual sigue activa'
fi

if ! compose "$NEW_IMAGE" up --detach --remove-orphans; then
  if [[ -n "$CURRENT_IMAGE" ]] && compose "$CURRENT_IMAGE" up --detach --remove-orphans; then
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
    compose "$NEW_IMAGE" down --remove-orphans || true
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
  printf 'inventory deployment: health check falló para %s; iniciando rollback\n' "$NEW_IMAGE" >&2
  if [[ -n "$CURRENT_IMAGE" ]]; then
    if compose "$CURRENT_IMAGE" up --detach --remove-orphans inventory-svc; then
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
  compose "$NEW_IMAGE" down --remove-orphans || true
  rm -f "$ACTIVE_FILE"
  fail 'health check falló; no había una versión anterior que restaurar'
fi

printf '%s\n' "$NEW_IMAGE" > "${ACTIVE_FILE}.tmp"
mv "${ACTIVE_FILE}.tmp" "$ACTIVE_FILE"
printf 'inventory deployment: activo %s; anterior registrado en %s\n' "$NEW_IMAGE" "$PREVIOUS_FILE"
