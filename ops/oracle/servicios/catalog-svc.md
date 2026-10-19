# Ficha — catalog-svc

## A. Identidad

Owner Poma; rama `poma` (snapshot consultado `570bf025afabf956f94cbac8fe2589aa197cabac`, no fusionado). Puerto 3001 / `CATALOG_SVC_PORT`. Schema `catalog`. Proyecto/contenedor `g6-catalog-svc`; generic Compose; `/etc/g6-catalog-svc/runtime.env`; estado `/var/lib/g6-productos-ofertas/catalog-svc`. Oracle 19-oct: desplegado/healthy, `/health/ready` 503; no GET comercial exitoso confirmado. `master` ref `9205eb455c4965a82ccb9fc4714cf976e4c059b0`; revisar su código distinto de rama pendiente `apps/catalog-svc/`.

## B. Configuración runtime

| Variable | Uso | Fuente/secreto | Consumidor / validación |
|---|---|---|---|
| `NODE_ENV`, `PORT`, `CATALOG_SVC_PORT` | Compose pone production y puerto | Compose | `config.ts`, `http-config.ts`; puerto requerido/validado |
| `CATALOG_SVC_HOST` | bind host | runtime; no secreto | `http-config.ts`, default 127.0.0.1; para Docker debe ser accesible dentro de contenedor, validar con owner |
| `PGHOST`,`PGPORT`,`PGDATABASE`,`PGUSER`,`PGPASSWORD` | conexión PostgreSQL schema catalog | administrador DB suministra; `PGPASSWORD` secreto | `database.ts`; obligatorias, valid host/port/role |
| `PGSSLMODE`,`PGSSLROOTCERT` | TLS y CA | runtime path; CA montada por Compose en `/run/g6-certs/supabase-server-root.crt`; no secreto | `database.ts`; `verify-full`, CA legible |
| `G6_DATABASE_SCHEMA`,`G6_EXPECTED_ROLE`,`G6_CONNECTION_MODE` | schema/identidad/mode | Marco/DB owner autoriza rol | `database.ts`; schema literal `catalog`, expected role whitelist `catalog_dev_login`/`catalog_app`, mode `session`/`direct` |
| `G6_CONNECT_HOST` | opcional conexión con identidad hostname aparte | runtime; no secreto | `database.ts`; IP/hostname validado |
| `CATALOG_TAXONOMY_URL` | URL de Taxonomy; condicional según demo/uso | runtime; no secreto | `taxonomy-config.ts`; origin privado sin credenciales |
| `CATALOG_MARKETPLACE_DEMO_PREVIEW_ENABLED` | default false; preview de demo | runtime privado | `config.ts`; bool; no autoriza datos falsos |
| `CATALOG_PRICING_URL` | requerida si preview true | runtime privado | `config.ts`; solo `http://pricing-svc:3002` |
| `DATABASE_URL` | parser soporta alternativa/configuración DB | runtime secreto | `database.ts`; usar config soportada exacta; no mezclar esquemas de fuentes |
| `RABBITMQ_URL`, `CATALOG_AMQP_PRODUCER_USERS` | aparecen en rama personal `poma`, no afirmar master/deployment | secreto URL + identidad suministrada por owner | implementación candidata AMQP; requiere reconciliar AsyncAPI y red antes de activar |

Compose inyecta NODE_ENV/PORT/service port y CA; resto por env_file privado. No copies runtime values.

## C. Dependencias

Supabase PostgreSQL TLS verify-full; `g6-http` alias `catalog-svc`; Taxonomy por URL privada. Pricing solo condición preview. Rabbit `poma` candidate sin conectividad autorizada; ver [red](../MATRIZ_DEPENDENCIAS.md).

## D. HTTP / seguridad

OpenAPI oficial docs SHA `c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b`, `0.6.0-rc.1`, tag Productos. Evidencia de demo en `apps/api-gateway/INT-ASAP-RESULTADO.md` y tests identifica dos GET de negocio: `GET /api/v1/productos?canal=MARKETPLACE&q=...` y `GET /api/v1/productos/por-slug/{slug}?canal=MARKETPLACE`; ambos dieron 503 en el corte documentado por falta de candidatos válidos. El tercer GET que aparece en el artefacto demo de respaldo es `GET /api/v1/productos/{productoId}` y **responde 503 estático desde `scripts/demo-fallback/`, no es una llamada a Catalog ni evidencia de endpoint usado en el flujo comercial**. Por tanto, las fuentes disponibles respaldan dos endpoints comerciales utilizados y una ruta fallback; la afirmación de tres endpoints de negocio requiere confirmación de Poma/owner de demo. `GET /health` 200; readiness 503 Oracle. Reglas comerciales requieren canal y elegibilidad; JWT/scope OpenAPI. Fixtures e2e mockeadas no prueban DB real.

## E. RabbitMQ

Branch `poma` candidate references `po.commands.x`, `po.events.x`, `po.results.x`, `po.catalog.q`, `po.retry.x`, `po.dlx.x`; Oracle physical equivalents base son español y sin retry/DLX. No desplegable hasta acuerdo/nombres, bindings, consumer/producer, ACK y permisos. Identidad física registrada `g6_catalogo` no implica permiso para nombres ingleses.

## F. Persistencia

Schema `catalog`, rol limitado esperado, select queries para readiness y demo. Branch/CI incluyen fixtures PostgreSQL aislado y tests de grants; confirmar migraciones aplicables exactas del SHA antes de release. Bootstrap verifica identidad y no debe ejecutar migraciones.

## G. Pruebas y aceptación

`npm run build:catalog-svc`; `npm test -- apps/catalog-svc`; `npm run test:e2e -- apps/catalog-svc`; `npm run typecheck`; `npm run lint`; `bash ops/oracle/build-service.sh catalog-svc`; build `Dockerfile.service`; PostgreSQL disposable, TLS/readiness y smoke de list/detail con datos autorizados. CI omite smoke readiness Catalog por runtime DB ausente y ejecuta Marketplace PostgreSQL integration en job dedicado.

## H. Bloqueos y entrega

Poma: resolver readiness 503 con permisos/config/db evidence; confirmar endpoints de demo (solo dos rutas comerciales verificables); demostrar lectura positiva y negativa. Rabbit boundary bloqueada hasta reconciliación y acceso de red autorizado. Marco: runtime privado/rol existente, release autorizada, no publicar fallback productivo.
