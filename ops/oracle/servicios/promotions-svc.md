# Ficha — promotions-svc

## A. Identidad

Owner Cueva; rama `cueva` snapshot `3f42e0e474071a13eb1b3120819d142cfeda4a95`, pendiente. Puerto 3004 / `PROMOTIONS_SVC_PORT`; schema `promotions` en código candidato. Proyecto/contenedor `g6-promotions-svc`; generic Compose; runtime `/etc/g6-promotions-svc/runtime.env`; estado `/var/lib/g6-productos-ofertas/promotions-svc`. Oracle 19-oct no desplegado. Master SHA referencia `9205eb455c4965a82ccb9fc4714cf976e4c059b0`; no presentar branch como merged.

## B. Configuración runtime

| Variable | Estado / uso | Fuente / validación |
|---|---|---|
| `NODE_ENV`,`PORT`,`PROMOTIONS_SVC_PORT` | Compose producción/3004 | main/bootstrap de SHA actual; confirmar parser |
| `PGHOST`,`PGPORT`,`PGDATABASE`,`PGUSER`,`PGPASSWORD`,`PGSSLMODE`,`PGSSLROOTCERT` | candidate `cueva` PostgreSQL | runtime privado; PGPASSWORD secreto; parser/bootstrap branch pendiente; TLS verify-full/CA antes release |
| `G6_DATABASE_SCHEMA`,`G6_EXPECTED_ROLE`,`DATABASE_URL` | consultar config real rama antes usar; no generalizar nombres fuera de source | no introducir valores hasta contrato DB/runtime aprobado |
| `RABBITMQ_URL` | branch `cueva` candidate | secreto; config and reachability not verified; block pending topology reconciliation |

Compose monta CA de solo lectura e inyecta NODE_ENV/puerto; resto runtime privado. No consta validación de producción desde Oracle.

## C. Dependencias

PostgreSQL candidate schema promotions; Rabbit events candidate, red isolated; `g6-http` pendiente al no estar desplegado; ningún upstream HTTP probado.

## D. HTTP / seguridad

OpenAPI official rc.1 define promociones/cupones/recomendaciones. Current branch business controllers deben compararse operation por operation al merge; scaffold master no demuestra implementación completa. `/health` liveness; readiness dependencias real pendiente. Requiere JWT/scopes contractuales; no activar demo no-auth en producción.

## E. RabbitMQ

Branch `cueva` usa `po.commands.x`/`po.results.x`; test/código observa `po.events.x` y `inventory.stock.changed`; Oracle usa names españoles. Usuario físico `g6_promociones` tiene lectura `po.promociones.q`, escritura `po.resultados.x`, sin configure; el nombre del consumer candidate no coincide. Retry/DLX no aprobado. Acceso requiere permiso broker y red privada autorizados; ver [RABBITMQ_COMPATIBILIDAD.md](../RABBITMQ_COMPATIBILIDAD.md).

## F. Persistencia

Branch candidate declara schema `promotions`; lista tablas/DDL/rol exacto por verificar del commit antes de release, no aplicar migraciones al arranque. Necesita pruebas PostgreSQL desechables y decisiones de reglas contractuales.

## G. Pruebas y aceptación

`npm run build:promotions-svc`; `npm test -- apps/promotions-svc`; `npm run test:e2e -- apps/promotions-svc`; `npm run typecheck`; `npm run lint`; `bash ops/oracle/build-service.sh promotions-svc`; Docker generic Compose; pruebas DB/Rabbit aisladas cuando existan. No hay smoke Oracle; sin producción AMQP.

## H. Bloqueos y entrega

Cueva: demostrar paridad OpenAPI/AsyncAPI y readiness real; resolver exchange/queue/keys/retry con owner de contrato; evidencia DB/TLS/AMQP y permisos mínimos. Marco: mecanismo red broker, credenciales y release con autorización propia.
