# Operación H5 — `combos-svc` con Azure Service Bus Basic (R05 / R12)

## 1. Alcance y colas

`combos-svc` es consumidor exclusivo de eventos internos H5 sobre **Azure Service Bus Basic**:

| Relación | Cola | Productor | Eventos | Handler Inbox |
|---|---|---|---|---|
| **R05** | `g6.combos.from.catalog` | `catalog-svc` | `catalog.sku.deactivated`, `catalog.product.deactivated` | `combos.catalog.sku.deactivated`, `combos.catalog.product.deactivated` |
| **R12** | `g6.combos.from.inventory` | `inventory-svc` | `inventory.stock.changed` | `combos.inventory.stock.changed` |

No utiliza topics, subscriptions administradas ni sesiones.

## 2. Variables de entorno y valores por defecto

| Variable | Valor por defecto (OFF) | Requerida en H5 ON | Descripción |
|---|---|---|---|
| `MESSAGING_PROVIDER` | no definida (`RABBITMQ` implícito) | `AZURE_SERVICE_BUS` | Selecciona transporte exclusivo H5. |
| `COMBOS_SERVICE_BUS_EVENTS_ENABLED` | `false` / no definida | `true` | Activa los dos receivers ASB. Con `false`, no crea `ServiceBusClient` ni requiere namespace/identidad. |
| `SERVICE_BUS_NAMESPACE_FQDN` | no definida | `<namespace>.servicebus.windows.net` | Namespace Service Bus Basic sin connection string SAS. |
| `AZURE_CLIENT_ID` | no definida | UUID v4 no nulo (obligatorio en `NODE_ENV=production`) | Client ID de la Managed Identity asignada a `combos-svc`. |
| `G6_SERVICE_BUS_PRODUCTION_ENABLED` | `false` / no definida | `true` (en `NODE_ENV=production`) | Guardrail fail-closed de activación productiva H5. |
| `G6_SECURITY_MODE` | `G7_AUTHENTICATED` | `G7_AUTHENTICATED` (en `NODE_ENV=production`) | Modo de seguridad exigido en producción. |
| `COMBOS_CATALOG_URL` | no definida | URL privada HTTPS / `*.svc` | Destino para resolver `catalog.product.deactivated` vía `GET /api/v1/productos/skus/{sku}/contexto`. |
| `COMBOS_G7_TOKEN_URL` / `COMBOS_G7_CLIENT_SECRET` | no definida | Requerida para M2M `catalogo:leer` | Emisión de token M2M para `CombosServiceIdentity`. |

Cuando `MESSAGING_PROVIDER=AZURE_SERVICE_BUS`, `COMBOS_AMQP_ENABLED=true` o `COMBOS_AMQP_URL` no vacío provocan fallo fail-closed (`COMBOS_SERVICE_BUS_CONFIGURATION_INVALID`).

## 3. Identidad y RBAC mínimo

- `combos-svc` usa `ManagedIdentityCredential` (o `DefaultAzureCredential` fuera de producción si `AZURE_CLIENT_ID` no está definido).
- Permiso mínimo requerido: **`Azure Service Bus Data Receiver`** únicamente sobre `g6.combos.from.catalog` y `g6.combos.from.inventory`.
- Prohibido asignar `Azure Service Bus Data Owner` o connection strings SAS en runtime.
- Gateway, Browser, G1 y G5 no tienen acceso al namespace.

## 4. Readiness (`/ready` y `/health/ready`)

- **H5 OFF** (`COMBOS_SERVICE_BUS_EVENTS_ENABLED=false`): `readinessStatus()` es `disabled`; la disponibilidad del servicio depende solo de PostgreSQL.
- **H5 ON**: reporta `ready` (`200 OK`) únicamente cuando PostgreSQL está disponible **y** ambos receivers (`g6.combos.from.catalog` y `g6.combos.from.inventory`) están suscritos y superan el probe periódico `peekMessages(1)`.
- Si falla una cola, el enlace, RBAC o la inicialización, responde `503` (`error` / `not_ready`) sin fallback a RabbitMQ.

## 5. Settlement, reintentos, DLQ y riesgo de `maxDeliveryCount`

- **Commit confirmado en PostgreSQL (`combos.inbox` + `combos.component_projection`):** `completeMessage`.
- **Duplicado idéntico en `combos.inbox`:** `completeMessage` sin segundo efecto.
- **Mismo `message_id` con contenido incompatible (`InboxMessageConflictError`):** `deadLetterMessage` con `COMBOS_MESSAGE_ID_CONFLICT`.
- **Mensaje contractualmente inválido** (tamaño > 256 KB con propiedades, JSON/UTF-8 inválido, cola/evento no permitido, `messageId`/`correlationId` ausente o inconsistente, `applicationProperties` incompatibles): `deadLetterMessage` con razón estable (`INVALID_*`) sin exponer secretos ni payload completo en logs.
- **Error temporal** (PostgreSQL, red, Catalog `503`/`401`/`403`/`404` o timeout): se aplica backoff acotado (`min(2000ms, deliveryCount * 250ms)`) y `abandonMessage`, dejando el evento sin confirmar en `combos.inbox`.
- **Riesgo de `maxDeliveryCount`:** si Catalog, G7 o PostgreSQL permanecen caídos o sin permisos durante más intentos que el `maxDeliveryCount` configurado en la cola de Azure Service Bus (por defecto 10), el broker moverá automáticamente el mensaje a la DLQ del sistema (`MaxDeliveryCountExceeded`). Ante incidentes prolongados de G7/Catalog, corregir la dependencia y reprocesar la DLQ de forma controlada.
- **Pérdida de ACK tras commit:** el redelivery encuentra la fila en `combos.inbox` y ejecuta `completeMessage` de forma inocua.

## 6. Rotación/pérdida de identidad y recuperación

- Si falla `catalogo:leer` (`401`/`403` o configuración ausente), `CombosServiceIdentity` invalida la caché de token una vez y reintenta; si persiste, el evento `catalog.product.deactivated` se abandona y queda registrado `catalog_mapping_blocked` en logs y `catalogAuthBlocked: true` en `getObservabilitySnapshot()`.
- Si un receiver ASB pierde conexión o cierra su enlace, `processError` marca la cola como `not_ready` y el probe periódico intenta recrear el receiver y re-suscribirse de forma idempotente sin duplicar suscripciones.

## 7. Reconciliación previa al corte y Rollback H5 → H4

1. **Antes de activar H5:** drenar o clasificar mensajes pendientes en `po.combos.q` (RabbitMQ H4), verificar que no existan consumidores H4 y H5 activos en paralelo y confirmar que `combos.inbox` está intacto.
2. **Rollback H5 → H4:** establecer `COMBOS_SERVICE_BUS_EVENTS_ENABLED=false`, `MESSAGING_PROVIDER=RABBITMQ`, `COMBOS_AMQP_ENABLED=true` y `COMBOS_AMQP_URL` válido. La tabla compartida `combos.inbox` preserva la deduplicación por `(message_id, handler)`.
