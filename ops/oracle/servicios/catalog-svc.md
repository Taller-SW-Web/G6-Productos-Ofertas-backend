# Ficha — catalog-svc

## A. Identidad

Owner Poma; HEAD de `origin/poma` contrastado: `a81f2d5fa735d7353b5df0ec0f095abac489e5d3` (pendiente, no integrado). Puerto 3001 / `CATALOG_SVC_PORT`. Schema `catalog`. Proyecto/contenedor `g6-catalog-svc`; Compose genérico; `/etc/g6-catalog-svc/runtime.env`; estado `/var/lib/g6-productos-ofertas/catalog-svc`. En Oracle al corte 19-oct estaba desplegado y Docker healthy, pero `/health/ready` devolvía 503. Esa readiness general es independiente de las respuestas de demo descritas abajo.

## B. Configuración runtime

| Variable | Uso | Fuente/secreto | Consumidor / validación |
|---|---|---|---|
| `NODE_ENV`, `PORT`, `CATALOG_SVC_PORT` | Compose pone production y puerto | Compose | `config.ts`, `http-config.ts`; puerto requerido/validado |
| `CATALOG_SVC_HOST` | bind host; opcional | Dockerfile genérico define `CATALOG_SVC_HOST=0.0.0.0`; runtime solo si se sobrescribe | `http-config.ts`; Compose/Dockerfile ya lo inyecta para contenedor |
| `PGHOST`,`PGPORT`,`PGDATABASE`,`PGUSER`,`PGPASSWORD` | conexión PostgreSQL schema catalog | administrador DB suministra; `PGPASSWORD` secreto | `database.ts`; obligatorias, valid host/port/role |
| `PGSSLMODE`,`PGSSLROOTCERT` | TLS y CA | runtime path; CA montada por Compose en `/run/g6-certs/supabase-server-root.crt`; no secreto | `database.ts`; `verify-full`, CA legible |
| `G6_DATABASE_SCHEMA`,`G6_EXPECTED_ROLE`,`G6_CONNECTION_MODE` | schema/identidad/mode | Marco/DB owner autoriza rol | `database.ts`; schema literal `catalog`, expected role whitelist `catalog_dev_login`/`catalog_app`, mode `session`/`direct` |
| `G6_CONNECT_HOST` | opcional conexión con identidad hostname aparte | runtime; no secreto | `database.ts`; IP/hostname validado |
| `CATALOG_TAXONOMY_URL` | URL de Taxonomy; condicional según demo/uso | runtime; no secreto | `taxonomy-config.ts`; origin privado sin credenciales |
| `CATALOG_MARKETPLACE_DEMO_PREVIEW_ENABLED` | default false; preview de demo | runtime privado | `config.ts`; bool; no autoriza datos falsos |
| `CATALOG_PRICING_URL` | requerida si preview true | runtime privado | `config.ts`; solo `http://pricing-svc:3002` |
| `DATABASE_URL` | no soportada como alternativa | no configurar | `CatalogConfig` exige variables `PG*`; el test de configuración rechaza que `DATABASE_URL` las sustituya |
| `SECURITY_ISSUER`, `SECURITY_DISCOVERY_URL`, `SECURITY_JWKS_URL` | opcionales, pero las tres deben configurarse juntas si se configura alguna | runtime.env; URLs públicas, no tokens | configuración de seguridad candidata; validar HTTPS/forma en el código de la rama |
| `RABBITMQ_URL`, `CATALOG_AMQP_PRODUCER_USERS` | opcionales al arrancar; activan AMQP si se configuran | runtime.env; URL/usuarios son sensibles | código candidato de Poma; bloqueo de deploy AMQP hasta compatibilidad de nombres, red y permisos |
| `CATALOG_PREPARATION_TIMEOUT_MS` | opcional, entero positivo | runtime.env | límite de preparación; respetar validador del SHA |

Compose inyecta `NODE_ENV=production`, `PORT=3001`, `CATALOG_SVC_PORT=3001` y monta CA en solo lectura. El Dockerfile define `CATALOG_SVC_HOST=0.0.0.0`. El resto de valores requeridos/condicionales procede de `runtime.env`; no copies valores.

## C. Dependencias

Supabase PostgreSQL TLS verify-full; `g6-http` alias `catalog-svc`; Taxonomy por URL privada. Pricing solo condición preview. Rabbit `poma` candidate sin conectividad autorizada; ver [red](../MATRIZ_DEPENDENCIAS.md).

## D. HTTP / seguridad

OpenAPI de docs `origin/master` SHA `c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b`, `0.6.0-rc.1`, gobierna Productos. La guía de demo `apps/api-gateway/INT-ASAP-MARKETPLACE.md` identifica tres GET públicos comprobados mediante HTTPS sin token el 2026-10-19 23:46 UTC: (1) `GET /api/v1/categorias` → **200** (lo atiende Taxonomy, no Catalog); (2) `GET /api/v1/productos?canal=MARKETPLACE&q=codex-audit&pagina=1&tamanio=24` → **200**, lista vacía (`items=0`); (3) `GET /api/v1/productos/por-slug/codex-audit-nonexistent?canal=MARKETPLACE` → **404** para slug deliberadamente inexistente. Son resultados HTTP reales del recorrido público, no evidencia de producto comercial positivo ni de readiness general. En particular, la auditoría Oracle del 19-oct registró `/health/ready` de Catalog **503**; mantener ambos estados separados. No atribuir el endpoint de categorías a Catalog ni usar la ruta fallback `/productos/{productoId}` como endpoint probado.

## E. RabbitMQ

Branch `poma` candidate references `po.commands.x`, `po.events.x`, `po.results.x`, `po.catalog.q`, `po.retry.x`, `po.dlx.x`; Oracle physical equivalents base son español y sin retry/DLX. No desplegable hasta acuerdo/nombres, bindings, consumer/producer, ACK y permisos. Identidad física registrada `g6_catalogo` no implica permiso para nombres ingleses.

## F. Persistencia

Schema `catalog`, rol limitado esperado, select queries para readiness y demo. Branch/CI incluyen fixtures PostgreSQL aislado y tests de grants; confirmar migraciones aplicables exactas del SHA antes de release. Bootstrap verifica identidad y no debe ejecutar migraciones.

## G. Pruebas y aceptación

`npm run build:catalog-svc`; `npm test -- apps/catalog-svc`; `npm run test:e2e -- apps/catalog-svc`; `npm run typecheck`; `npm run lint`; `bash ops/oracle/build-service.sh catalog-svc`; build `Dockerfile.service`; PostgreSQL disposable, TLS/readiness y smoke de list/detail con datos autorizados. CI omite smoke readiness Catalog por runtime DB ausente y ejecuta Marketplace PostgreSQL integration en job dedicado.

## H. Bloqueos y entrega

Poma: investigar y corregir readiness 503; añadir una prueba con producto válido para demostrar respuesta comercial positiva. Rabbit candidate bloqueado hasta reconciliación y red autorizada. Marco: suministrar runtime privado/rol y autorizar release cuando los gates estén satisfechos; no publicar fallback productivo.
