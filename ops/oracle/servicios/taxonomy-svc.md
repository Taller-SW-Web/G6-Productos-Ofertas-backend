# Ficha — taxonomy-svc

## A. Identidad

Owner Lopez; rama `lopez` (`c6032dffd42dfa0eeeb9cbe8477b3de076c64e6d`, snapshot consultado; ver historial/merge para SHA fuente exacto). Puerto 3006 / `TAXONOMY_SVC_PORT`; schema `taxonomy`. Proyecto/contenedor `g6-taxonomy-svc`, generic Compose, runtime `/etc/g6-taxonomy-svc/runtime.env`, estado `/var/lib/g6-productos-ofertas/taxonomy-svc`. Oracle 19-oct: desplegado/healthy; `/health/readiness` y `/health/ready` 200; categorías GET 200 vía Gateway/directo. `master` SHA reference `9205eb455c4965a82ccb9fc4714cf976e4c059b0`.

## B. Configuración runtime

| Variable | Requisito | Bootstrap |
|---|---|---|
| `NODE_ENV`,`PORT`,`TAXONOMY_SVC_PORT` | production/3006 por Compose | `src/config/environment.ts`; puerto validado |
| `DATABASE_URL` | requerida, incluye credencial PostgreSQL (secreto) | environment config valida URL/host; provider DB; TLS settings por deployment |
| `PGSSLMODE`,`PGSSLROOTCERT` | verificar en config/provider del SHA antes variar | CA montada ro por Compose, no revela validez config |

No crear otros env names no consumidos. Compose inyecta NODE_ENV/PORT/TAXONOMY_SVC_PORT; runtime env DB privado.

## C. Dependencias

PostgreSQL schema taxonomy, readiness ejecuta consultas de lectura categories/brands. `g6-http` alias `taxonomy-svc`; Catalog depende de Taxonomy por HTTP privado. Oracle GET categorías y readiness sí observados; no probaron otros upstreams. Sin conexión AMQP probada desde VM.

## D. HTTP / seguridad

OpenAPI docs origin/master SHA `c36bd9a...`, rc.1 tag Taxonomía. Código actual `taxonomy.controller.ts` incluye `GET /api/v1/categorias` y `GET /api/v1/marcas`; revisar rutas extra contra OpenAPI. `/health/readiness` y `/health/ready` ambos 200 observados; `GET /api/v1/categorias` 200 vía Gateway, la única ruta de negocio probada externamente al alcance auditado. JWT/scopes según contrato; no deducir permiso público.

## E. RabbitMQ

Infra física user `g6_taxonomia` permite write sobre exchanges base y read `po.taxonomia.q`, pero app runtime AMQP no acreditada por evidencia actual. AsyncAPI gobierna eventos; no habilitar publisher hasta comparar nombres y conectar red aprobada. No retry/DLX.

## F. Persistencia

Schema `taxonomy`; readiness de lectura observada a PostgreSQL. Rol/migraciones y permisos se deben contrastar con DDL del SHA; consultas de read master data; no DDL al bootstrap. Tests DB real aislados desde script CI taxonomy integration.

## G. Pruebas y aceptación

`npm run build:taxonomy-svc`; `npm test -- apps/taxonomy-svc`; `npm run test:e2e -- apps/taxonomy-svc`; `npm run typecheck`; `npm run lint`; `bash ops/oracle/build-service.sh taxonomy-svc`; Docker generic Compose; `node scripts/ci/run-taxonomy-integration.mjs` para PostgreSQL desechable; readiness + categorías/marcas por Gateway con auth apropiada. CI ejecuta integración Taxonomy dedicada, no todos los HTTP flows.

## H. Bloqueos y entrega

Lopez: mantener evidencia de DB/readiness por SHA y ampliar funcional smoke contractual. Marco: confirmar estado runtime y autorización si hay nuevo SHA; Gateway necesita arreglar dependencia Catalog antes readiness completa. Operatividad de categorías no implica producto completo.
