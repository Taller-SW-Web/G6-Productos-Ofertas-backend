# Ficha — inventory-svc

## A. Identidad

Owner Taco; rama `taco` snapshot `01b5619160364951b620fbc8aa8494a0386cd82a` pendiente. Puerto 3005 / `INVENTORY_SVC_PORT`; schema/role deben cotejarse con migrations/DB contract de SHA, no se infieren aquí. Proyecto `g6-inventory`, Compose legado `docker-compose.inventory.yml`, unidad `inventory-svc`, contenedor `g6-inventory-svc`; runtime `/etc/g6-inventory/runtime.env`; estado `/var/lib/g6-inventory`. Oracle 19-oct no desplegado. master `9205eb455c4965a82ccb9fc4714cf976e4c059b0` no implica código de `taco` ya integrado.

## B. Configuración runtime

| Variable | Requisito / secreto | Código de rama / bootstrap |
|---|---|---|
| `PORT`,`INVENTORY_SVC_PORT` | puerto Compose 3005; no secreto | `src/config/inventory.config.ts`, integer 1–65535 |
| `DATABASE_URL` | opcional parser field; si se usa credencial secreta | inventory config; validar modo final/mutua exclusión con PG* antes deploy |
| `PGHOST`,`PGPORT`,`PGDATABASE`,`PGUSER`,`PGPASSWORD`,`PGSSLMODE`,`PGSSLROOTCERT` | DB params; contraseña secreta, CA path | `inventory.config.ts`; port validado, TLS y obligatoriedad deben verificarse en provider/startup del SHA |
| `RABBITMQ_URL` | AMQP candidate; secreto | config field; no conexión Oracle desde red HTTP |
| `RESERVATION_TTL_SECONDS` | default 900, >=1 | integer validated |
| `DEFAULT_LOW_STOCK_THRESHOLD` | default 5, >=0 | integer validated |
| `INVENTORY_WORKER_INTERVAL_MS` | default 5000, rango 250..2147483647 | integer validated |
| `INVENTORY_WORKER_BATCH_SIZE` | default 50, 1..500 | integer validated |
| `INVENTORY_DEMO_NO_AUTH_ENABLED` | default false; excepción puntual solo dos operaciones | `loadCommercialDemoConfig`; boolean |
| `INVENTORY_DEMO_GATEWAY_IPS` | requerido si demo true, IPs literales | config canonicaliza IP, rechaza inválidas |
| `G7_JWT_ISSUER`,`G7_JWT_PUBLIC_KEY`/`JWT_PUBLIC_KEY` | identificar fuente exacta en snapshot antes de runtime | no inventar aliases; valores identidad pública/privada según implementación, secreto si clave privada (no se presume) |

Compose legado inyecta NODE_ENV/puerto por el ejecutor y monta CA en overlay HTTP; variables aplicación por runtime file privado.

## C. Dependencias

PostgreSQL TLS y Rabbit candidate; su Compose puede unirse `g6-http` vía overlay opt-in, no `g6-edge`. Rabbit sigue aislado. No localhost para containers. Outbox/Inbox candidate exige DB y broker reales en tests.

## D. HTTP / seguridad

OpenAPI oficial rc.1 lista availability, reservation, consume/release, thresholds/dashboard; branch personal implementa endpoints deben mapearse al contrato exacto. `/health` liveness; readiness real de DB/broker pendiente confirmar. Demo no-auth está restringido en config a `consultarDisponibilidadComercial` y `verificarCantidadComercial` desde IPs Gateway exactas; no quitar JWT en rutas generales. No hay despliegue al corte.

## E. RabbitMQ

Branch `taco` contiene Outbox/Inbox pero exactos exchanges/queues/routing keys se deben cotejar con AsyncAPI antes liberar. Broker Oracle tiene `po.inventario.q` y usuario `g6_inventario` read queue/write eventos/results; no equivale a conectividad ni nombres del código. Retry/DLX bloqueado.

## F. Persistencia

DB schema/tabla/transacciones de reservas, stock, outbox/inbox deben verificarse desde migrations exactas de SHA. Nunca ejecutar DDL al bootstrap. Probar idempotencia/atomicidad y SQL real aislado.

## G. Pruebas y aceptación

`npm run build:inventory-svc`; `npm test -- apps/inventory-svc`; `npm run test:e2e -- apps/inventory-svc`; `npm run typecheck`; `npm run lint`; `bash ops/oracle/build-service.sh inventory-svc`; `docker-compose.inventory.yml` + HTTP overlay; PostgreSQL/Rabbit aislados para reservation/outbox/readiness. CI build Dockerfile inventory y `/health` solamente; no acredita DB readiness ni AMQP.

## H. Bloqueos y entrega

Taco: entregar compatibilidad exacta de topología, TLS readiness, permiso mínimo, outbox/inbox con pruebas reproducibles y ruta funcional no destructiva. Marco: red Rabbit aislada autorizada y deployment approval individual. No usar smoke que cambie stock en Oracle.
