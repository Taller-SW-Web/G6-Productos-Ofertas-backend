# Diagnóstico Técnico de Implementación — Defectos A/B/C y Consolidación H5

> La trazabilidad consolidada de Hito 5, la evidencia reproducible de Frontend y las evidencias históricas intactas residen en `G6-Productos-Ofertas-docs` ([PR #154](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/pull/154)).

## 1. PRs independientes en Draft (cero colisión con `#310` y `#103`)

| PR | Rama | SHA verificado | Alcance | Validación local y nivel de evidencia |
|---|---|---|---|---|
| **Backend [#313](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/pull/313)** | `poma-hito-5-pruebas-v2` | HEAD de esta rama | Harness Postman/Newman (`H11`–`H25`), helper seguro PG17 (`H26`), suite complementaria Catalog sin duplicar `#310`, e integración real `Gateway -> Catalog -> Pricing -> Inventory` (`H27`). | `npm run validate` OK (`STRICT_OFFICIAL`), **`32/32 PASS`** (`PASS / MOCK`), **`3/3 PASS`** complemento Catalog (`PASS / ISOLATED (PostgreSQL descartable)`), **`3/3 PASS`** Vitest `H27` (`PASS / ISOLATED (PostgreSQL descartable)`). |
| **Backend [#314](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/pull/314)** | `trabajo/poma/h5-apim-errores-autenticacion` | `6a5da558` | **Defecto A (`H28`):** Normalización RFC 7807 en `ops/azure/apim/policies/api.xml` para `validate-jwt` + verificación de políticas efectivas heredadas (`<on-error><base /></on-error>`), `correlationId` idéntico en header/body y preservación de `403`/`429`. | **`27/27 PASS`** (`PASS / STATIC`, sin despliegue en APIM real). |
| **Backend [#315](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/pull/315)** | `trabajo/poma/h5-bulk-autenticacion` | `2a484ba0` | **Defecto C (`H29`):** `BulkUserBearerGuard` admite JWT humano `tipo === 'acceso'` sin `aud`, corrección del test `nbf` futuro con claims válidos, y regresiones HTTP e2e reales de `PM-030` (`200 text/csv`) y `PM-031` (`404 LOTE_NO_ENCONTRADO`) + `401`/`403`. | **`13/13 PASS`** unit + **`4/4 PASS`** HTTP e2e (`17/17 PASS / ISOLATED (código productivo)`). |

## 2. Consolidación de equivalencias Catalog H5 respecto a Backend #310 (`6dd66036`)

Se contrastó nuestra suite frente a la base canónica de **Backend #310** (`6dd66036baf675f8ee2197ab3cb9e9754a0d0886`):
- `tests/h5/catalog-bulk-inventory.postgres.e2e-spec.ts`
- `tests/h5/taxonomy-service-bus.postgres.e2e-spec.ts`
- `apps/catalog-svc/test/postgres.persistence.e2e-spec.ts`
- `apps/inventory-svc/test/inventory.real.integration.spec.ts`

Se eliminó toda duplicación de recorridos completos ya acreditados en `#310`, conservando en `apps/catalog-svc/test/h5/catalog-h5-equivalence.postgres.e2e-spec.ts` únicamente las garantías complementarias no duplicadas (**`3/3 PASS`** sobre PostgreSQL 17 descartable):

| Escenario histórico | Base canónica en Backend #310 | Garantía complementaria exclusiva en Backend #313 |
|---|---|---|
| `TAXONOMY-UPDATES` | Cubierto por `tests/h5/taxonomy-service-bus.postgres.e2e-spec.ts` (3 eventos, reinicio tras ACK perdido, R18 AsyncAPI, rollback). | `C3`: Conflicto de payload en `catalog.inbox` (mismo `message_id` con payload alterado → `InvalidCatalogMessage`) y bloqueo preventivo con `CATALOG_H5_TAXONOMY_REPLY_DISABLED`. |
| `BLOCK-A2` | Cubierto por `tests/h5/catalog-bulk-inventory.postgres.e2e-spec.ts` y `apps/inventory-svc/test/inventory.real.integration.spec.ts`. | No duplicado. |
| `BULK-JOINT` y `BULK-CONSUMER-v2` | Cubiertos por `tests/h5/catalog-bulk-inventory.postgres.e2e-spec.ts`. | `C3`: Bloqueo preventivo ante destino `g6.bulk.from.catalog` deshabilitado (`CATALOG_H5_BULK_REPLY_DISABLED`). |
| `JOINT-01` | Cobertura parcial en `#310` (sin activación completa Pricing+Inventory). | `C1`: Activación comercial real `BORRADOR -> ACTIVO` en `catalog.products` tras resultados de Pricing e Inventory + relay Outbox con fallo ambiguo (`RETRY` → `CONFIRMED`) + estado `TERMINAL`. |
| `JOINT-01-REGRESSION` | No cubierto específicamente para falsificación de correlación. | `C2`: Rechazo estricto de `correlation_id` falsificado sobre `causation_id` activo (`InvalidCatalogMessage`) + descarte `STALE` de residuo con `causation_id` ajeno. |

## 3. Resultados exactos de `H27` (Vitest vs casos individuales Newman)

En `apps/catalog-svc/test/h5/catalog-h5-newman-real.postgres.e2e-spec.ts` se levantan `api-gateway`, `catalog-svc`, `pricing-svc` e `inventory-svc` **productivos reales** sobre PostgreSQL 17 descartable (`h5_catalog_isolated`, rol `catalog_app`/`pricing_app`, JWKS RS256 sintético local):

| Bloque Vitest (`3/3 PASS`) | Perfil / Carpeta Newman ejecutada | Casos Newman individuales | Veredicto Newman |
|---|---|---|---|
| `H27 positivo real (Carpeta 01)` | `01 - Catalog y Pricing` | `PM-002`, `PM-003A`, `PM-003B`, `PM-003C`, `PM-003D` (`5/5 PASS`, `0 FAIL`, `0 NOT_RUN`, validado con H24 Ajv) | `PASS` (`exitCode=0`) |
| `H27 positivo/negativo real Inventory (Carpeta 02)` | `02 - Preparacion comercial e Inventory` (4 corridas reales contra `inventory-svc` + PG17) | Esc. 1 (1 ubicación sin `location_id`): `3/3 PASS` (`PM-010`, `PM-011`, `PM-012` `200`). Esc. 2 (multi-ubicación sin `location_id`): `2 PASS` + `PM-012 FAIL (400 VALIDACION)`. Esc. 3 (multi-ubicación con `location_id` UUID): `3/3 PASS`. Esc. 4 (ubicación sin saldo): `2 PASS` + `PM-012 FAIL (200 items=[])`. | `PASS` / `FAIL` según escenario contractual |
| `H27 preflight y negativos reales (Carpetas 00 y 09)` | `00 - Preflight y autenticacion` y `09 - APIM, Gateway y G7` | Carpeta 00: `PM-001` (`200 PASS`), `PM-001B` (`503 FAIL` preservado honestamente por servicios no levantados). Carpeta 09: `PM-004`, `PM-004B`, `PM-006`, `PM-007A`, `PM-007B`, `PM-008` (`6/6 PASS`), `PM-005` (`NOT_RUN`). | `FAIL` (00) / `PARTIAL_NOT_COMPLETE` (`exitCode=5`, 09) |
