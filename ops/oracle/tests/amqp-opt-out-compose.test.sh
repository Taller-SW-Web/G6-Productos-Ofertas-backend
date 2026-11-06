#!/usr/bin/env bash
set -Eeuo pipefail

for executable in docker curl; do
  command -v "$executable" >/dev/null 2>&1 || { printf 'NO EJECUTADO: falta %s\n' "$executable"; exit 0; }
done
docker compose version >/dev/null 2>&1 || { printf 'NO EJECUTADO: Docker Compose v2 no disponible\n'; exit 0; }
docker info >/dev/null 2>&1 || { printf 'NO EJECUTADO: daemon Docker no disponible\n'; exit 0; }

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
readonly TEMP_ROOT="$(mktemp -d)"
readonly PROJECT="g6-amqp-optout-$$"
readonly HTTP_NETWORK="${PROJECT}-http"
readonly AMQP_NETWORK="${PROJECT}-amqp"
readonly CONTAINER="${PROJECT}-service"
readonly BASE="$TEMP_ROOT/base.yml"
readonly AMQP="$TEMP_ROOT/amqp.yml"
cleanup() {
  docker compose --project-name "$PROJECT" --file "$BASE" down --remove-orphans >/dev/null 2>&1 || true
  docker network rm "$AMQP_NETWORK" >/dev/null 2>&1 || true
  rm -rf "$TEMP_ROOT"
}
trap cleanup EXIT

docker network create --driver bridge "$AMQP_NETWORK" >/dev/null
cat > "$BASE" <<EOF
services:
  service:
    image: nginx:alpine
    container_name: $CONTAINER
    ports:
      - "127.0.0.1::80"
    networks:
      default: {}
      http:
        aliases: [service-http]
networks:
  default: {}
  http:
    name: $HTTP_NETWORK
EOF
cat > "$AMQP" <<EOF
services:
  service:
    networks:
      default: {}
      http:
        aliases: [service-http]
      amqp:
        aliases: [service-amqp]
networks:
  default: {}
  http:
    name: $HTTP_NETWORK
  amqp:
    external: true
    name: $AMQP_NETWORK
EOF

compose() {
  docker compose --project-name "$PROJECT" --file "$BASE" "$@"
}
network_state() {
  docker inspect --format "{{if index .NetworkSettings.Networks \"$1\"}}true{{else}}false{{end}}" "$CONTAINER"
}
assert_http() {
  local port
  port="$(compose port service 80 | awk -F: 'NR==1 {print $NF}')"
  [[ "$port" =~ ^[0-9]+$ ]] || { printf 'FAIL: no se resolvió puerto HTTP loopback\n' >&2; return 1; }
  for _ in {1..30}; do
    if curl --fail --silent --max-time 2 "http://127.0.0.1:$port/" >/dev/null; then return 0; fi
    sleep 1
  done
  printf 'FAIL: HTTP dejó de responder en el puerto loopback\n' >&2
  return 1
}

compose --file "$AMQP" up --detach --force-recreate service
[[ "$(network_state "$AMQP_NETWORK")" == true ]] || { printf 'FAIL: servicio sin perfil AMQP tras opt-in\n' >&2; exit 1; }
[[ "$(network_state "$HTTP_NETWORK")" == true ]] || { printf 'FAIL: servicio perdió red HTTP con AMQP activo\n' >&2; exit 1; }
assert_http
printf 'PASS: perfil opt-in adjunta AMQP y conserva HTTP\n'

compose up --detach --force-recreate service
[[ "$(network_state "$AMQP_NETWORK")" == false ]] || { printf 'FAIL: servicio conserva membresía AMQP tras opt-out\n' >&2; exit 1; }
[[ "$(network_state "$HTTP_NETWORK")" == true ]] || { printf 'FAIL: opt-out eliminó la conectividad HTTP\n' >&2; exit 1; }
assert_http
printf 'PASS: recreación Compose opt-out quita la red AMQP y HTTP continúa respondiendo\n'
