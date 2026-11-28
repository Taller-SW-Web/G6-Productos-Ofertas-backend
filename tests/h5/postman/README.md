# Suite Ejecutable de Pruebas de Integración HTTP — Postman / Newman (G6 Hito 5)

Fuente única de verdad ejecutable del harness Postman/Newman para **G6 — Productos y Ofertas (Hito 5)**, con dependencias aisladas (`newman@6.2.3`, `ajv`, `ajv-formats`, `yaml`) y cero interferencia con el `package.json` raíz o workflows de CI/CD.

> **Estado operativo (`STANDBY` en infraestructura real):** No se ejecutan pruebas contra Azure APIM, ACA, Service Bus ni G7 hasta autorización expresa.

## Validación contractual estricta (`H17` + `H22`)

- **Modo predeterminado (`STRICT_OFFICIAL`):** `npm run validate` exige el contrato oficial `contratos/http/openapi.yaml` (`0.7.0-rc.3`) y la matriz `cobertura-integracion.csv` en `G6-Productos-Ofertas-docs` (variable `G6_DOCS_ROOT`), registra el SHA de Docs y el SHA-256 del contrato, y realiza comparación estructural profunda (`verifySchemaContractAlignment`: `required`, `type`, `enum`, `format`, `minimum`, `exclusiveMinimum`, `additionalProperties`, `$ref`).
- **Runner Newman + Ajv:** `scripts/run-newman.mjs` compila directamente el OpenAPI oficial con **Ajv + ajv-formats** y valida **todas las respuestas HTTP JSON ejecutadas (principales y auxiliares)**.
- **Postman Desktop:** Debido a limitaciones del sandbox de Postman Desktop, la colección embebe el validador recursivo `assertSchema` derivado de `schemas/openapi-response-schemas.json` (sincronizado y verificado contra el OpenAPI oficial).
- **Modo rápido no acreditable:** `--fast-dev` permite desarrollo local rápido contra `openapi.filtered.yaml` sin sustituir jamás la validación contractual completa para el cierre H5.

## Fixtures explícitos por identidad (`H18` + `H20`)

- `PM-012` **no** elige arbitrariamente la primera ubicación de `/inventario/ubicaciones`; utiliza `G6_LOCATION_ID` explícito cuando corresponde.
- `PM-080`/`PM-081` (`modulo-marketplace`) utilizan `G6_MARKETPLACE_SKU` (o el SKU descubierto por el propio `PM-080`).
- `PM-082` (`modulo-ventas`) utiliza `G6_VENTAS_SKU` y `G6_VENTAS_LOCATION_ID` explícitos, sin llamar nunca a `/inventario/ubicaciones` con token M2M; ante ausencia de fixture registra `NOT_RUN / BLOCKED_FIXTURE`.
- `PM-003A`/`PM-003B` validan exhaustivamente los conjuntos de `product_id` (hasta 5 páginas; si se trunca con `SAMPLED_MAX_5_PAGES` no se declara subconjunto aprobado); `PM-003C`/`PM-003D` validan precios efectivos y canal sobre una **muestra explícita** (1 producto del rango amplio + 1 producto del rango acotado).

## Comandos locales reproducibles

```powershell
# 1) Validación contractual estricta (requiere checkout de Docs o G6_DOCS_ROOT)
cd tests/h5/postman
npm ci
npm run validate

# 2) Suite de regresiones del harness (27 pruebas H01-H22, incluye 2 servidores H21 y 4 escenarios Inventory H18)
npm test

# 3) Equivalencias auténticas Catalog H5 (H16) + Newman contra api-gateway/catalog-svc reales (H19) con PG17 descartable
# (desde la raíz de Backend con contenedor postgres:17-alpine y migraciones oficiales aplicadas)
$env:CATALOG_H5_DISPOSABLE_PG='1'
npx vitest run --config ./vitest.config.e2e.ts apps/catalog-svc/test/h5/catalog-h5-equivalence.postgres.e2e-spec.ts
npx vitest run --config ./vitest.config.e2e.ts apps/catalog-svc/test/h5/catalog-h5-newman-real.postgres.e2e-spec.ts
```

## Convención de niveles de evidencia

- `PASS / MOCK`: Regresiones del harness contra servidor simulado controlado (`tests/h5/postman/tests/*.test.mjs`).
- `PASS / ISOLATED (servicios reales + PostgreSQL 17 descartable)`: Ejecución contra código productivo real (`api-gateway`, `catalog-svc`, `CatalogMutationService`, `CatalogBulkService`, `CatalogMessageService`) sobre PostgreSQL 17 descartable.
- `FAIL / LAB_AZURE histórico`: Defectos reproducidos en corridas reales previas (conservados sin alteración en Docs PR #154).
- `NOT_RUN`: Caso omitido por `BLOCKED_AUTH` o `BLOCKED_FIXTURE`.
- `STANDBY`: Validación en infraestructura real diferida hasta autorización.
