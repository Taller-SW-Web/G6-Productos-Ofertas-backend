#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TEMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEMP_ROOT"' EXIT
mkdir -p "$TEMP_ROOT/bin" "$TEMP_ROOT/etc"
cat > "$TEMP_ROOT/bin/stat" <<'MOCK_STAT'
#!/usr/bin/env bash
if [[ "${1:-}" == -c && "${2:-}" == '%u:%a' ]]; then printf '0:0640\n'; else exec /usr/bin/stat "$@"; fi
MOCK_STAT
chmod +x "$TEMP_ROOT/bin/stat"
PATH="$TEMP_ROOT/bin:$PATH"
export PATH
cp "$ROOT/ops/oracle/amqp-opt-in.sh" "$TEMP_ROOT/amqp-opt-in.sh"
sed -i "s|/etc/g6-productos-ofertas/amqp-opt-in.psv|$TEMP_ROOT/etc/amqp-opt-in.psv|g" "$TEMP_ROOT/amqp-opt-in.sh"
sed -i 's|/opt/g6-productos-ofertas/shared/docker-compose.service.amqp.yml|/not-used/generic.yml|g; s|/opt/g6-productos-ofertas/inventory/docker-compose.inventory.amqp.yml|/not-used/inventory.yml|g' "$TEMP_ROOT/amqp-opt-in.sh"
chmod 640 "$TEMP_ROOT/etc"
source "$ROOT/ops/oracle/service-registry.sh"
source "$TEMP_ROOT/amqp-opt-in.sh"

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$1"; }

RUNTIME="$TEMP_ROOT/etc/runtime.env"
OPTIN="$TEMP_ROOT/etc/amqp-opt-in.psv"
printf '%s\n' 'BULK_AMQP_URL=amqp://bulk:secret@rabbitmq:5672/g6-productos-ofertas' > "$RUNTIME"
chmod 640 "$RUNTIME"

g6_amqp_service_opted_in bulk-svc || fail 'la ausencia de manifiesto debe dejar AMQP desactivado'
[[ "$G6_AMQP_SELECTED" == false ]] || fail 'AMQP estaba seleccionado sin manifiesto'
pass 'AMQP desactivado por defecto sin inspeccionar red'

printf '%s\n' '#g6-amqp-opt-in-version=1' 'bulk-svc' > "$OPTIN"
chmod 640 "$OPTIN"
G6_SERVICE_ENV_FILE="$RUNTIME"
g6_amqp_service_opted_in bulk-svc || fail 'la selección individual válida fue rechazada'
[[ "$G6_AMQP_SELECTED" == true ]] || fail 'bulk-svc no quedó seleccionado'
pass 'selección individual y configuración Bulk válidas'

for invalid in 'api-gateway' 'caddy' 'unknown-svc' 'bulk-svc|combos-svc'; do
  printf '%s\n' '#g6-amqp-opt-in-version=1' "$invalid" > "$OPTIN"
  chmod 640 "$OPTIN"
  if g6_amqp_service_opted_in bulk-svc >/dev/null 2>&1; then fail "manifiesto inválido aceptado: $invalid"; fi
done
pass 'Gateway, Caddy, nombres desconocidos y filas no canónicas rechazados'

printf '%s\n' '#g6-amqp-opt-in-version=1' 'bulk-svc' 'bulk-svc' > "$OPTIN"
chmod 640 "$OPTIN"
if g6_amqp_service_opted_in bulk-svc >/dev/null 2>&1; then fail 'fila duplicada aceptada'; fi
pass 'selección duplicada rechazada'

printf '%s\n' '#g6-amqp-opt-in-version=1' 'bulk-svc' > "$OPTIN"
printf '%s\n' 'BULK_AMQP_URL=' > "$RUNTIME"
if g6_amqp_service_opted_in bulk-svc >/dev/null 2>&1; then fail 'configuración parcial aceptada'; fi
printf '%s\n' 'BULK_AMQP_URL=not-a-url' > "$RUNTIME"
if g6_amqp_service_opted_in bulk-svc >/dev/null 2>&1; then fail 'URL inválida aceptada'; fi
pass 'configuración parcial e inválida rechazadas sin imprimir secretos'

for service in bulk-svc catalog-svc combos-svc inventory-svc taxonomy-svc promotions-svc pricing-svc price-audit-svc; do
  case "$service" in
    bulk-svc) key=BULK_AMQP_URL; scheme=amqp ;;
    catalog-svc|inventory-svc|promotions-svc|taxonomy-svc) key=RABBITMQ_URL; scheme=amqp ;;
    combos-svc) key=COMBOS_AMQP_URL; scheme=amqp ;;
    pricing-svc) key=PRICING_AMQP_URL; scheme=amqps ;;
    price-audit-svc) key=PRICE_AUDIT_AMQP_URL; scheme=amqps ;;
  esac
  printf '%s\n' "${key}=${scheme}://user:secret@rabbitmq:5671/g6-productos-ofertas" > "$RUNTIME"
  if [[ "$service" == taxonomy-svc ]]; then printf '%s\n' 'TAXONOMY_CATALOG_AMQP_USER=catalog-user' >> "$RUNTIME"; fi
  g6_amqp_validate_runtime_config "$service" "$RUNTIME" || fail "configuración ${service} válida fue rechazada"
done
printf '%s\n' 'PRICING_AMQP_URL=amqp://user:secret@rabbitmq:5672/g6-productos-ofertas' > "$RUNTIME"
if g6_amqp_validate_runtime_config pricing-svc "$RUNTIME" >/dev/null 2>&1; then fail 'Pricing aceptó AMQP sin TLS'; fi
pass 'configuración de los ocho servicios cotejada; Pricing/Price Audit exigen AMQPS'

for service in bulk-svc catalog-svc combos-svc inventory-svc price-audit-svc pricing-svc promotions-svc taxonomy-svc; do
  case "$service" in
    bulk-svc) key=BULK_AMQP_URL; scheme=amqp ;;
    catalog-svc|inventory-svc|promotions-svc|taxonomy-svc) key=RABBITMQ_URL; scheme=amqp ;;
    combos-svc) key=COMBOS_AMQP_URL; scheme=amqp ;;
    pricing-svc) key=PRICING_AMQP_URL; scheme=amqps ;;
    price-audit-svc) key=PRICE_AUDIT_AMQP_URL; scheme=amqps ;;
  esac
  printf '%s\n' "${key}=${scheme}://user:secret@rabbitmq:5671/g6-productos-ofertas" > "$RUNTIME"
  if [[ "$service" == taxonomy-svc ]]; then printf '%s\n' 'TAXONOMY_CATALOG_AMQP_USER=catalog-user' >> "$RUNTIME"; fi
  printf '%s\n' '#g6-amqp-opt-in-version=1' "$service" > "$OPTIN"
  G6_SERVICE_ENV_FILE="$RUNTIME"
  g6_amqp_service_opted_in "$service" || fail "opt-in individual rechazado para $service"
  [[ "$G6_AMQP_SELECTED" == true ]] || fail "selección individual ausente para $service"
done
pass 'opt-in individual confirmado para los ocho microservicios'

printf '%s\n' 'BULK_AMQP_URL=amqp://bulk:secret@broker-externo:5672/g6-productos-ofertas' > "$RUNTIME"
if g6_amqp_validate_runtime_config bulk-svc "$RUNTIME" >/dev/null 2>&1; then fail 'host distinto del alias privado aceptado'; fi
pass 'URL AMQP que apunta fuera del alias privado rechazada'

printf '%s\n' 'COMBOS_AMQP_ENABLED=enabled' 'COMBOS_AMQP_URL=amqp://user:secret@rabbitmq:5672/g6-productos-ofertas' > "$RUNTIME"
if g6_amqp_validate_runtime_config combos-svc "$RUNTIME" >/dev/null 2>&1; then fail 'flag booleano inválido aceptado'; fi
printf '%s\n' 'PROMOTIONS_COUPON_RUNTIME_ENABLED=yes' 'RABBITMQ_URL=amqp://user:secret@rabbitmq:5672/g6-productos-ofertas' > "$RUNTIME"
if g6_amqp_validate_runtime_config promotions-svc "$RUNTIME" >/dev/null 2>&1; then fail 'flag Promotions inválido aceptado'; fi
pass 'flags de runtime parciales o inválidos rechazados antes del despliegue'

if command -v jq >/dev/null 2>&1; then
  printf '%s\n' 'CATALOG_AMQP_ENABLED=true' 'RABBITMQ_URL=amqp://catalog:secret@rabbitmq:5672/g6-productos-ofertas' 'CATALOG_AMQP_PRODUCER_USERS={"pricing-svc":"pricing","inventory-svc":"inventory","taxonomy-svc":"taxonomy","bulk-svc":"bulk"}' > "$RUNTIME"
  g6_amqp_validate_runtime_config catalog-svc "$RUNTIME" || fail 'usuarios productores Catalog válidos rechazados'
  printf '%s\n' 'CATALOG_AMQP_ENABLED=true' 'RABBITMQ_URL=amqp://catalog:secret@rabbitmq:5672/g6-productos-ofertas' 'CATALOG_AMQP_PRODUCER_USERS={invalid-json' > "$RUNTIME"
  if g6_amqp_validate_runtime_config catalog-svc "$RUNTIME" >/dev/null 2>&1; then fail 'JSON de productores Catalog inválido aceptado'; fi
  pass 'JSON de productores Catalog se valida sin imprimir identidades'
else
  printf 'NO EJECUTADO: jq requerido para probar JSON de productores Catalog\n'
fi

cat > "$TEMP_ROOT/bin/docker" <<'MOCK_DOCKER'
#!/usr/bin/env bash
set -Eeuo pipefail
format=''
container="${!#}"
while (($#)); do
  if [[ "$1" == --format ]]; then format="$2"; shift 2; else shift; fi
done
case "$format" in
  *'.Containers'*) printf '%s\n' "${G6_TEST_NETWORK_MEMBERS:-g6-po-rabbitmq-1}" ;;
  *'.Name'*) [[ "${G6_TEST_NETWORK_MISSING:-false}" != true ]] || exit 1; printf '%s\n' "${G6_TEST_NETWORK_CONTRACT:-g6-po_g6_backend|bridge|local|false|false|false|false|default|1|0}" ;;
  *'com.docker.compose.service'*)
    case "$container" in
      g6-po-rabbitmq-1) printf 'rabbitmq|g6-po\n' ;;
      g6-bulk-svc) printf 'service|g6-bulk-svc\n' ;;
      g6-combos-svc) printf 'service|g6-combos-svc\n' ;;
      *) exit 1 ;;
    esac ;;
  *'NetworkSettings.Networks'*)
    case "$container" in
      g6-po-rabbitmq-1) for alias in ${G6_TEST_RABBIT_ALIASES:-rabbitmq g6-rabbitmq g6-po-rabbitmq-1}; do printf '%s\n' "$alias"; done ;;
      g6-bulk-svc) for alias in ${G6_TEST_BULK_ALIASES:-bulk-svc service}; do printf '%s\n' "$alias"; done ;;
      g6-combos-svc) printf 'combos-svc\nservice\n' ;;
      *) exit 1 ;;
    esac ;;
  *) exit 1 ;;
esac
MOCK_DOCKER
chmod +x "$TEMP_ROOT/bin/docker"
G6_SERVICE_NAME=bulk-svc
g6_service_config bulk-svc
G6_SERVICE_ENV_FILE="$RUNTIME"
printf '%s\n' 'BULK_AMQP_URL=amqp://bulk:secret@rabbitmq:5672/g6-productos-ofertas' > "$RUNTIME"
G6_AMQP_SERVICES=(bulk-svc)
g6_amqp_validate_network g6-bulk-svc || fail 'la red con RabbitMQ y Bulk válidos fue rechazada'
pass 'red privada bridge y miembros Compose esperados aceptados'

G6_TEST_NETWORK_CONTRACT='g6-po_g6_backend|host|local|false|false|false|false|default|1|0'
export G6_TEST_NETWORK_CONTRACT
if g6_amqp_validate_network g6-bulk-svc >/dev/null 2>&1; then fail 'red con driver incompatible aceptada'; fi
G6_TEST_NETWORK_MISSING=true
export G6_TEST_NETWORK_MISSING
if g6_amqp_validate_network g6-bulk-svc >/dev/null 2>&1; then fail 'red AMQP inexistente aceptada'; fi
G6_TEST_NETWORK_MISSING=false
export G6_TEST_NETWORK_MISSING
G6_TEST_NETWORK_CONTRACT='g6-po_g6_backend|bridge|local|false|false|false|false|default|1|0'
G6_TEST_NETWORK_MEMBERS=$'g6-po-rabbitmq-1\nforeign-container'
export G6_TEST_NETWORK_CONTRACT G6_TEST_NETWORK_MEMBERS
if g6_amqp_validate_network g6-bulk-svc >/dev/null 2>&1; then fail 'contenedor ajeno aceptado'; fi
G6_TEST_NETWORK_MEMBERS=$'g6-po-rabbitmq-1\ng6-bulk-svc'
G6_TEST_BULK_ALIASES='rabbitmq service'
export G6_TEST_NETWORK_MEMBERS G6_TEST_BULK_ALIASES
if g6_amqp_validate_network g6-bulk-svc >/dev/null 2>&1; then fail 'alias RabbitMQ duplicado aceptado'; fi
G6_TEST_NETWORK_MEMBERS='g6-po-rabbitmq-1'
G6_TEST_BULK_ALIASES='bulk-svc service'
G6_TEST_RABBIT_ALIASES='rabbitmq bulk-svc'
export G6_TEST_NETWORK_MEMBERS G6_TEST_BULK_ALIASES G6_TEST_RABBIT_ALIASES
if g6_amqp_validate_network g6-bulk-svc >/dev/null 2>&1; then fail 'alias objetivo ya ocupado por RabbitMQ aceptado'; fi
pass 'red incompatible, contenedor ajeno y alias conflictivo rechazados'

if grep -Eq '^[[:space:]]*ports:' "$ROOT/ops/oracle/docker-compose.service.amqp.yml" "$ROOT/ops/oracle/docker-compose.inventory.amqp.yml"; then fail 'overlay AMQP publica puertos'; fi
if grep -Eq 'g6-po_g6_backend|amqp' "$ROOT/ops/oracle/docker-compose.gateway.yml"; then fail 'Gateway conectado a RabbitMQ'; fi
pass 'overlays no publican puertos y Gateway queda fuera de RabbitMQ'

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  env G6_SERVICE_IMAGE=bulk-svc:test G6_SERVICE_CONTAINER=g6-bulk-svc G6_SERVICE_PORT=3008 G6_SERVICE_PORT_ENV=BULK_SVC_PORT G6_SERVICE_IMAGE_NAME=bulk-svc G6_SERVICE_ENV_FILE="$RUNTIME" \
    docker compose --project-name g6-bulk-svc --file "$ROOT/ops/oracle/docker-compose.service.yml" --file "$ROOT/ops/oracle/docker-compose.service.amqp.yml" config --format json > "$TEMP_ROOT/compose.json"
  jq -e '(.services.service.networks | keys | sort) == ["amqp", "default"] and .services.service.networks.amqp.aliases == ["bulk-svc"] and .networks.amqp.external == true and .networks.amqp.name == "g6-po_g6_backend"' "$TEMP_ROOT/compose.json" >/dev/null || fail 'Compose AMQP genérico efectivo incorrecto'
  pass 'composición efectiva agrega RabbitMQ privado solo con overlay explícito'
else
  printf 'NO EJECUTADO: Docker Compose no está disponible para config efectivo\n'
fi

printf 'Todas las pruebas opt-in AMQP aisladas pasaron.\n'
