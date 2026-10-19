# Ficha — inventory-svc

## A. Identidad

Owner Taco; HEAD contrastado `origin/taco` `b02615841f63ea3249d9ad16a0cf32f4ea2b20c2`, pendiente. Puerto 3005 / `INVENTORY_SVC_PORT`; schema físico `inventory` (ver [esquemas](../SUPABASE_ESQUEMAS.md)); configuración candidata DB debe verificarse contra provider antes de runtime. Proyecto `g6-inventory`, Compose `docker-compose.inventory.yml`, contenedor `g6-inventory-svc`; runtime `/etc/g6-inventory/runtime.env`; estado `/var/lib/g6-inventory`. No desplegado al corte Oracle 19-oct.

## B. Configuración runtime

| Variable | Requisito / secreto | Código de rama / bootstrap |
|---|---|---|
| `PORT`,`INVENTORY_SVC_PORT` | puerto Compose 3005; no secreto | `src/config/inventory.config.ts`, integer 1–65535 |
| `DATABASE_URL` | campo opcional de config; provider candidato acepta URL o campos PG, reglas exclusivas no demostradas por config sola | runtime.env; URL contiene credenciales | Verificar comportamiento exacto del provider en este SHA antes de liberar |
| `PGHOST`,`PGDATABASE`,`PGUSER`,`PGPASSWORD`,`PGSSLMODE`,`PGSSLROOTCERT` | opcionales en parser de config; DB provider necesita configuración utilizable; contraseña secreta y CA path | runtime.env, no copiar valores | `inventory.config.ts` lee campos; no demuestra conectividad ni TLS real |
| `PGPORT` | opcional; default 5432 y entero 1–65535 | Compose no lo inyecta; runtime.env si cambia | `inventory.config.ts` |
| `RABBITMQ_URL` | opcional para bootstrap; requerida para flujo AMQP | runtime.env; secreto | config candidata; conexión al broker no verificada ni autorizada |
| `RESERVATION_TTL_SECONDS` | default 900, >=1 | integer validated |
| `DEFAULT_LOW_STOCK_THRESHOLD` | default 5, >=0 | integer validated |
| `INVENTORY_WORKER_INTERVAL_MS` | default 5000, rango 250..2147483647 | integer validated |
| `INVENTORY_WORKER_BATCH_SIZE` | default 50, 1..500 | integer validated |
| `INVENTORY_DEMO_NO_AUTH_ENABLED` | default false; excepción puntual solo dos operaciones | `loadCommercialDemoConfig`; boolean |
| `INVENTORY_DEMO_GATEWAY_IPS` | requerido si demo true, IPs literales | config canonicaliza IP, rechaza inválidas |
| `G7_JWT_ISSUER`,`G7_JWT_PUBLIC_KEY`/`JWT_PUBLIC_KEY` | no son leídas por `inventory.config.ts`; confirmar otro consumidor antes de provisionar | no inferir aliases ni secreto | no acreditadas por config en HEAD `b0261584` |

Dockerfile propio fija `NODE_ENV=production` y `EXPOSE 3005`. Compose de producción inyecta `NODE_ENV`, `PORT=3005`, `INVENTORY_SVC_PORT=3005` y monta la CA de solo lectura en el overlay HTTP. Los valores de negocio/DB/demo deben venir de `/etc/g6-inventory/runtime.env`.

## C. Dependencias

PostgreSQL TLS y Rabbit candidate; su Compose puede unirse `g6-http` vía overlay opt-in, no `g6-edge`. Rabbit sigue aislado. No localhost para containers. Outbox/Inbox candidate exige DB y broker reales en tests.

## D. HTTP / seguridad

OpenAPI oficial rc.1 lista availability, reservation, consume/release, thresholds/dashboard; branch personal implementa endpoints deben mapearse al contrato exacto. `/health` liveness; readiness real de DB/broker pendiente confirmar. Demo no-auth está restringido en config a `consultarDisponibilidadComercial` y `verificarCantidadComercial` desde IPs Gateway exactas; no quitar JWT en rutas generales. No hay despliegue al corte.

## E. RabbitMQ

Branch `taco` consume `po.inventory.q`; el outbox elige `po.events.x` o `po.results.x` y usa `row.event_type` como routing key. La topología observada es `po.inventario.q`, `po.eventos.x` y `po.resultados.x`: incompatibilidad bloquea el deploy AMQP. Ver matriz común.

## F. Persistencia

DB schema/tabla/transacciones de reservas, stock, outbox/inbox deben verificarse desde migrations exactas de SHA. Nunca ejecutar DDL al bootstrap. Probar idempotencia/atomicidad y SQL real aislado.

## G. Pruebas y aceptación

`npm run build:inventory-svc`; `npm test -- apps/inventory-svc`; `npm run test:e2e -- apps/inventory-svc`; `npm run typecheck`; `npm run lint`; `bash ops/oracle/build-service.sh inventory-svc`; `docker-compose.inventory.yml` + HTTP overlay; PostgreSQL/Rabbit aislados para reservation/outbox/readiness. CI build Dockerfile inventory y `/health` solamente; no acredita DB readiness ni AMQP.

## H. Bloqueos y entrega

Taco: entregar compatibilidad exacta de topología, TLS readiness, permiso mínimo, outbox/inbox con pruebas reproducibles y ruta funcional no destructiva. Marco: red Rabbit aislada autorizada y deployment approval individual. No usar smoke que cambie stock en Oracle.
