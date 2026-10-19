# Ficha — api-gateway

## A. Identidad

| Campo | Dato |
|---|---|
| Owner / rama | Transversal; requiere Issue explícito y coordinación (backend `AGENTS.md`). No atribuir owner personal sin Issue. |
| Puerto / env | 3000 / `API_GATEWAY_PORT` (fallback `PORT`) |
| Schema / Docker | Sin DB propia conocida. Proyecto/contendor `g6-api-gateway`, Compose dedicado `docker-compose.gateway.yml`; runtime `/etc/g6-api-gateway/runtime.env`; estado `/var/lib/g6-productos-ofertas/api-gateway`. |
| Oracle (19-oct-2026) | Desplegado; Docker `unhealthy`; `/health` 200; readiness falla por Catalog `not_ready`, cobertura `partial`. `/api/v1/categorias` 200 vía Gateway. |
| Código | HEAD auditado `9205eb455c4965a82ccb9fc4714cf976e4c059b0`; sin rama personal del Gateway. CI exacto verde run `39342273073`. Código `apps/api-gateway/`. |

## B. Configuración runtime

| Variable | Uso / requisito | Suministro / secreto | Consumidor y bootstrap |
|---|---|---|---|
| `NODE_ENV`, `PORT`, `API_GATEWAY_PORT` | Compose inyecta `production`, 3000, `API_GATEWAY_PORT=3000` | Compose; no secreto | `gateway-settings.ts`; puerto entero 1–65535 |
| `GATEWAY_<SERVICE>_URL` | Opcional por upstream definido; origen HTTP(S) sin credenciales | runtime privado / no secreto | `gateway-settings.ts`; solo URL de origen |
| `GATEWAY_<SERVICE>_READINESS_PATH` | Opcional, solo con URL; path confirmado por owner y nunca liveness | runtime privado | valida formato y rechaza `/health` |
| `GATEWAY_TIMEOUT_MS` | opcional; default 5000, rango 1–60000 | runtime privado; no secreto | `gateway-settings.ts` |
| `AUTH_ISSUER`, `AUTH_JWKS_URL` | Pareadas cuando demo auth apagada; HTTPS sin user/pass/query/fragment | URL issuer/JWKS; normalmente no secreto | `gateway-settings.ts`; token verificación usa identidad contractual |
| `GATEWAY_PUBLIC_OPERATION_IDS` | opcional allowlist; solo operationId que OpenAPI marca público | runtime privado | `gateway-settings.ts`; lista inválida falla bootstrap |
| `GATEWAY_DEMO_NO_AUTH_ENABLED` | default false; demo no debe habilitarse en producción | runtime privado; no secreto | `gateway-settings.ts`; excepción de demo explícita |

Compose también conecta `g6-edge` alias `g6-api-gateway` y `g6-http` alias `api-gateway`; publica solo loopback. No imprimir valor runtime.

## C. Dependencias / red

HTTPS: Caddy→Gateway por `g6-edge`. Upstreams HTTP solo por `g6-http` y solo si service autorizado/readiness real. `GATEWAY_*_URL` se obtiene de configuración; gateway espera `/health/ready` por defecto del mapa de código/contrato y paths opcionales explícitos (confirmar exacto en `readiness.js` antes de configurar). No DB propia ni AMQP observados.

## D. HTTP / seguridad

Proxy/rutas autorizadas por `apps/api-gateway/src/routing/contract-routes.ts`, OpenAPI official `0.6.0-rc.1` (docs origin/master SHA `c36bd9a...`) y configuración. No anunciar rutas no incluidas. `/health` es liveness. Compose healthcheck ejecuta `node dist/apps/api-gateway/readiness.js`; auditoría falló al depender de Catalog. La ruta pública GET categorías fue probada; auth negativa 401 en otras rutas no es smoke funcional. JWT/JWKS y scopes del contrato prevalecen; no crear allowlist de operaciones públicas por intuición.

## E. RabbitMQ

No producer/consumer AMQP confirmado en el Gateway. No conectar broker. Ver [compatibilidad](../RABBITMQ_COMPATIBILIDAD.md).

## F. Persistencia

Sin persistencia propia conocida, migraciones o rol PostgreSQL. El Gateway no debe consultar schemas de otros servicios.

## G. Pruebas y aceptación

`npm run build:api-gateway`; `npm test -- apps/api-gateway`; `npm run typecheck`; `npm run lint`; `bash ops/oracle/build-service.sh api-gateway`; imagen `Dockerfile.service`; Compose Gateway + overlay HTTP; comprobar `/health`, readiness contra upstreams reales y una operación autorizada vía HTTPS. CI construye imagen y ejecuta readiness bundle, pero no prueba Gateway funcional completo ni token real.

## H. Bloqueos y entrega

Readiness bloqueada por Catalog al corte auditado. Antes de release, issue/owner transversal, cada upstream autorizado+listo, auth/JWKS/scope y routing funcional probados; Marco autoriza deployment individual. Registrar salud parcial y SHA.
