# Suite Ejecutable de Pruebas de Integración HTTP — Postman / Newman (G6 Hito 5)

Fuente única de verdad ejecutable del harness Postman/Newman para **G6 — Productos y Ofertas (Hito 5)**, con dependencias aisladas (`newman@6.2.3`, `ajv`, `ajv-formats`, `yaml`) y cero interferencia con el `package.json` raíz o workflows de CI/CD.

> **Estado operativo (`STANDBY` en infraestructura real):** No se ejecutan pruebas contra Azure APIM, ACA, Service Bus, G7 ni bases compartidas hasta autorización expresa.

## Validación contractual estricta (`H17`, `H22`, `H24`, `H25`)

- **Resolución contractual automática desde OpenAPI `0.7.0-rc.3` (`H24`):** `scripts/lib/openapi-schema-validator.mjs` resuelve el esquema Ajv directamente a partir de `(método HTTP, ruta efectiva, statusCode, Content-Type)` sobre el contrato oficial `contratos/http/openapi.yaml` (`0.7.0-rc.3`, 156 operaciones). No depende de mapeos manuales por `PM-XXX` y valida también respuestas auxiliares sin identificador `PM`.
- **Cero omisiones silenciosas:** Toda respuesta JSON no cubierta por una exención explícita (`/health`, `/health/ready`, `/api/v1/ruta-inexistente-h5-probe`) se valida con Ajv + `ajv-formats`; las desviaciones de `Content-Type` o de esquema en solicitudes principales o auxiliares bloquean el `PASS` global.
- **Comparación estructural recursiva:** `verifySchemaContractAlignment()` verifica recursivamente propiedades, ítems, `$ref`, `type`, `enum`, `const`, `pattern`, `format`, `minimum`, `maximum`, `exclusiveMinimum`, `required` y `additionalProperties`.
- **Preflight contractual obligatorio en `run-newman.mjs` (`H25`):** Antes de lanzar Newman en modo estricto (`STRICT_OFFICIAL`), `executeSuite()` verifica la existencia y alineación del contrato oficial y registra `contract.openApiSha256` y `contract.mode` en el reporte; si el contrato oficial falta o diverge, falla cerrado (`stage: "contract_preflight"`, `exitCode: 2`).
- **Modo rápido no acreditable:** `--fast-dev` permite desarrollo local rápido contra `openapi.filtered.yaml`, pero nunca sustituye la validación estricta `STRICT_OFFICIAL`.

## Fixtures explícitos por identidad (`H18` + `H20`)

- `PM-012` **no** elige arbitrariamente la primera ubicación de `/inventario/ubicaciones`; utiliza `G6_LOCATION_ID` (UUID) explícito cuando corresponde.
- `PM-080`/`PM-081` (`modulo-marketplace`) utilizan `G6_MARKETPLACE_SKU` (o el SKU descubierto por `PM-080`).
- `PM-082` (`modulo-ventas`) utiliza `G6_VENTAS_SKU` y `G6_VENTAS_LOCATION_ID` explícitos; ante ausencia de fixture registra `NOT_RUN / BLOCKED_FIXTURE`.
- `PM-003A`/`PM-003B` validan exhaustivamente los conjuntos de `product_id` (hasta 5 páginas; si trunca con `SAMPLED_MAX_5_PAGES` no se aprueba subconjunto); `PM-003C`/`PM-003D` validan precios efectivos y canal sobre muestra explícita (rango amplio + rango acotado).

## Comandos locales reproducibles

### 1. Validación contractual estricta y regresiones del harness (`H01`–`H25`)

```powershell
cd tests/h5/postman
npm ci
npm run validate
npm test
```

Resultado verificado: `[VALIDATE] OK [STRICT_OFFICIAL]` y **`32/32 PASS`** (`PASS / MOCK`).

### 2. Suites reales con PostgreSQL 17 descartable (`H26` + `H27` + complemento a `#310`)

El helper compartido `apps/catalog-svc/test/h5/disposable-pg17.helper.ts` (`H26`) exige host loopback (`127.0.0.1`/`localhost`), base dedicada `*_isolated`, rol runtime no propietario (`catalog_app`), motor PostgreSQL 17 (`170000 <= server_version_num < 180000`) y migraciones oficiales aplicadas.

```powershell
# A) Aprovisionar PostgreSQL 17 descartable en loopback (puerto 55432)
docker run -d --name g6-h5-pg17 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=h5_catalog_isolated -p 127.0.0.1:55432:5432 postgres:17-alpine

# B) Crear roles no propietarios y aplicar migraciones oficiales de catalog, pricing e inventory
# (po_catalog_owner / catalog_app + 8 migraciones catalog; po_pricing_owner / pricing_app + extensions.btree_gist + pricing.sql; inventory-initial.sql + inventory-operations.sql)

# C) Ejecutar suites reales (complemento Catalog H5 + Newman contra api-gateway, catalog-svc, pricing-svc e inventory-svc reales)
$env:CATALOG_H5_DISPOSABLE_PG='1'
$env:PGHOST='127.0.0.1'
$env:PGPORT='55432'
$env:PGDATABASE='h5_catalog_isolated'
$env:PGUSER='catalog_app'
$env:PGPASSWORD='app_pass'
npx vitest run --config ./vitest.config.e2e.ts apps/catalog-svc/test/h5/catalog-h5-equivalence.postgres.e2e-spec.ts apps/catalog-svc/test/h5/catalog-h5-newman-real.postgres.e2e-spec.ts

# D) Limpieza del contenedor descartable
docker rm -f g6-h5-pg17
```

## Convención de niveles de evidencia

- `PASS / MOCK`: Regresiones del harness contra servidor HTTP simulado controlado (`tests/h5/postman/tests/*.test.mjs`).
- `PASS / STATIC`: Validación estática de políticas XML de Azure APIM (`ops/azure/apim/tests/test_apim_artifacts.py`).
- `PASS / ISOLATED (código productivo)`: Pruebas unitarias y HTTP e2e sobre código productivo real sin infraestructura externa (p. ej. `bulk-svc` con RS256 sintético).
- `PASS / ISOLATED (PostgreSQL descartable)`: Ejecución contra servicios productivos reales (`api-gateway`, `catalog-svc`, `pricing-svc`, `inventory-svc`) sobre PostgreSQL 17 descartable en loopback con migraciones oficiales.
- `FAIL / LAB_AZURE histórico`: Defectos reproducidos en corridas reales previas (conservados intactos en Docs PR #154).
- `NOT_RUN`: Caso omitido explícitamente por `BLOCKED_AUTH` o `BLOCKED_FIXTURE`.
- `STANDBY`: Validación contra infraestructura real diferida hasta autorización expresa.
