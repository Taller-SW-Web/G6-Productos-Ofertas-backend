# API Gateway (`apps/api-gateway`) — Hito 5

Pasarela HTTP NestJS (`GatewayProxy`) para **G6 Productos y Ofertas**. Enruta exclusivamente pares `método + ruta + operationId` registrados de forma estática a los ocho microservicios internos y aplica validación JWT/G7, correlación, streaming, CORS y sanitización de errores en el borde del clúster.

## Procedencia contractual y rutas habilitadas

- **Contrato OpenAPI vigente:** `0.7.0-rc.3` (`APPROVED_G6` interno; Docs SHA `490172c11cb4b83ddd1996f8d5834d0402184cf8`).
- **Registro base (`src/routing/contract-routes.ts`):** rutas públicas/administrativas externas del contrato vigente (incluyendo `conciliarImportacionGeneralPorCorrelacion` de Bulk y `listarAlertasOperativasInventario` / `listarUbicacionesInventario` de Inventory H01/H02), más las dos excepciones históricas de Pricing (`obtenerDefinicionPrecioProductoAdministracion` y `obtenerDefinicionPrecioSkuAdministracion`) protegidas con `userBearer` y rol `GESTOR_COMERCIAL` hasta su regularización contractual.
- **Overlay G5 H5 (`src/routing/g5-h5-routes.ts`):** cuatro rutas protegidas (`admitirConsumoCuponH5`, `admitirRestauracionCuponH5`, `obtenerOperacionCuponH5`, `obtenerEstadoReservaH5`), separadas del registro base y deshabilitadas por defecto (`GATEWAY_G5_H5_ENABLED=false`).
- **Exclusiones internas (5 operaciones):** `obtenerContextoSku`, `obtenerContextosSkuLote`, `filtrarSkusVendiblesInterno`, `obtenerEvidenciaReservaCuponInterno` y `obtenerContenidoCargaMasivaInternoH5` devuelven siempre `404` en el Gateway incluso con JWT válido o `GATEWAY_G5_H5_ENABLED=true`.
- **Dependencia pendiente PR #255:** el delta de prevalidación CSV de Pricing en el PR #255 (Vera) permanece como dependencia externa hasta su fusión autorizada.

| Prefijo | Owner |
|---|---|
| `productos` | `catalog-svc` |
| `categorias`, `marcas`, `caracteristicas`, `tipos-producto`, `taxonomia`, `seo` | `taxonomy-svc` |
| `precios` | `pricing-svc` |
| `auditoria-precios` | `price-audit-svc` |
| `promociones`, `cupones`, `recomendaciones` | `promotions-svc` |
| `combos` | `combos-svc` |
| `inventario` | `inventory-svc` |
| `carga-masiva` | `bulk-svc` |

## Modos de seguridad y restricciones

- **`G6_SECURITY_MODE=G7_AUTHENTICATED` (predeterminado):** verificación RS256 nativa contra `AUTH_ISSUER` y `AUTH_JWKS_URL` HTTPS. Exige `tipo=acceso` + rol para rutas humanas y `tipo=servicio` + audiencia + scope + allowlist de cliente para rutas M2M. Falla cerrado (`401`/`403`/`503`) sin configuración válida.
- **`G6_SECURITY_MODE=PUBLIC_READ_ONLY`:** permite acceso anónimo únicamente a los `GET` elegibles explícitamente listados en `GATEWAY_PUBLIC_OPERATION_IDS`. Nunca habilita mutaciones ni lecturas protegidas. Puede coexistir con las cuatro rutas G5 H5 únicamente mediante `GATEWAY_G5_H5_ENABLED=true` y configuración G7 válida (`AUTH_ISSUER` y `AUTH_JWKS_URL`), manteniendo JWT, `scope`, `aud` y `client_id` obligatorios en G5.
- **`G6_SECURITY_MODE=SIMULATED_AUTH`:** reservado exclusivamente para pruebas locales aisladas; **no** habilita rutas G5 H5 (`GATEWAY_G5_H5_ENABLED=true` con `SIMULATED_AUTH` es rechazado al iniciar).
- **Modos demo retirados:** `GATEWAY_DEMO_NO_AUTH_ENABLED=true` y `G6_READ_ONLY_DEMO_ENABLED=true` son rechazados explícitamente al arranque. No existe un modo demo general sin autenticación.

## Transporte, CORS, correlación y observabilidad

- **Streaming y límites:** uploads `multipart/form-data` y descargas de archivos/CSV se transmiten por streaming con backpressure; el presupuesto JSON (`10 MiB` por defecto) no limita archivos legítimos. Los `413` tempranos drenan el stream entrante antes de responder.
- **CORS (`GATEWAY_CORS_ALLOWED_ORIGINS`):** orígenes HTTPS exactos separados por comas; sin wildcard. Expone `Content-Disposition`, `Location` y `X-Correlation-Id`. Vacío deshabilita CORS.
- **Correlación y logs:** `X-Correlation-Id` UUID válido se preserva (o genera si falta; inválido o duplicado devuelve `400`). Cada operación emite una línea JSON estructurada a `stdout` con `operationId`, `method`, `owner`, `status`, `durationMs`, `correlationId`, `resultOrigin` y `preUpstreamOutcome`, sin payloads, tokens, cookies, claims ni URLs privadas.
- **Dependencia APIM:** el Gateway no implementa rate limiting ni cuotas en NestJS; la protección de borde (burst, cuota, concurrencia, TLS externo y anti-bypass) corresponde a **Azure API Management** (`ops/azure/apim/`). Un SHA fusionado en GitHub no equivale a despliegue ni a validación APIM real.

## Configuración local (`.env.example`)

Copiar `apps/api-gateway/.env.example` a `apps/api-gateway/.env.local`. Precedencia: entorno de proceso > `apps/api-gateway/.env.local` > `.env` raíz.

- `API_GATEWAY_PORT` > `PORT` > `3000`
- `GATEWAY_TIMEOUT_MS`: entero `1..60000` (por defecto `5000`)
- `GATEWAY_<SERVICIO>_URL`: origin HTTP/HTTPS interno sin path, query ni credenciales
- `GATEWAY_<SERVICIO>_READINESS_PATH`: ruta de readiness verificada por owner (no usar `/health` ni `/health/live`)
- `AUTH_ISSUER` / `AUTH_JWKS_URL`: ambos o ninguno, HTTPS acordado con G7
- `G6_SECURITY_MODE`: `G7_AUTHENTICATED` (predeterminado), `PUBLIC_READ_ONLY` o `SIMULATED_AUTH`
- `GATEWAY_G5_H5_ENABLED`: `false` por defecto
- `GATEWAY_PUBLIC_OPERATION_IDS`: allowlist explícita de `GET` públicos elegibles
- `GATEWAY_CORS_ALLOWED_ORIGINS`: orígenes HTTPS exactos separados por comas

## Liveness, readiness y verificación

- `GET /health`: liveness del proceso sin llamadas a upstreams ni base de datos.
- `node dist/apps/api-gateway/readiness.js`: sonda de readiness que valida dependencias configuradas (`ready`, `not_ready`, `unverified`, `not_configured` y `coverage`).

```powershell
npm test -- apps/api-gateway --maxWorkers=1
npm run test:e2e -- apps/api-gateway --maxWorkers=1
npm run build:api-gateway
npm run typecheck
npm run lint
node apps/api-gateway/test/readiness.smoke.mjs
```
