# Diagnóstico Técnico de Implementación — Defectos A/B/C y Equivalencias Catalog (H5)

> La trazabilidad consolidada de Hito 5 y las evidencias históricas intactas residen en `G6-Productos-Ofertas-docs` ([PR #154](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/pull/154)). Este documento resume el estado técnico de las implementaciones en Backend.

## 1. PRs independientes en Draft

| PR | Rama | Alcance | Validación local |
|---|---|---|---|
| **Backend [#313](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/pull/313)** | `poma-hito-5-pruebas-v2` | Harness Postman/Newman (`H11`–`H22`), fixtures Inventory (`H18`/Defecto B), equivalencias auténticas Catalog (`H16`) y Newman sobre servicios reales (`H19`). | `npm run validate` OK (`STRICT_OFFICIAL`), `27/27 PASS` (`PASS / MOCK`), `5/5 PASS` H16 (`PASS / ISOLATED PG17`), `1/1 PASS` H19 (`PASS / ISOLATED servicios reales + PG17`). |
| **Backend [#314](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/pull/314)** | `trabajo/poma/h5-apim-errores-autenticacion` | **Defecto A:** Normalización RFC 7807 en `ops/azure/apim/policies/api.xml` exclusivamente para `Source == "validate-jwt"` y `StatusCode == 401`, + regresión en `test_apim_artifacts.py`. | `26/26 PASS` (`PASS / ISOLATED`, sin despliegue en APIM real). |
| **Backend [#315](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/pull/315)** | `trabajo/poma/h5-bulk-autenticacion` | **Defecto C:** Corrección en `apps/bulk-svc/src/auth/bulk-user-bearer.guard.ts` permitiendo `aud === undefined` en JWT humano `tipo === 'acceso'` (preservando rechazo `401` si `aud` es inválido y `403` por rol insuficiente). | `13/13 PASS` (`PASS / ISOLATED` con RS256 sintético). |

## 2. Cobertura real de las 6 brechas históricas de `catalog-svc` (`H16`)

Implementada en `apps/catalog-svc/test/h5/catalog-h5-equivalence.postgres.e2e-spec.ts` sobre **código productivo real** (`Database` con rol `catalog_app`, `CatalogMutationService`, `CatalogBulkService`, `CatalogMessageService`, `relayCatalogDelivery`, `createCatalogTaxonomyConsumer`, `createCatalogBulkConsumer`) y **PostgreSQL 17 descartable** con las 8 migraciones oficiales aplicadas (sin RabbitMQ ni modificación de `postgres.persistence.e2e-spec.ts`):

| Escenario | Garantía productiva acreditada en PG17 | Estado |
|---|---|---|
| `TAXONOMY-UPDATES` | `createCatalogTaxonomyConsumer` → `consumeTaxonomyUpdate` en `catalog.inbox`: v1/v2 `APPLIED`, v1 tardío `STALE`, reinicio de consumidor `DUPLICATE`, payload conflictivo `InvalidCatalogMessage`, reply deshabilitado bloquea antes de ACK. | `PASS / ISOLATED (PG17 real)` |
| `BLOCK-A2` | `CatalogMutationService.createProduct` + `CatalogMessageService.consume` para `inventory.sku.initialization.completed` / `rejected`, persistencia en `catalog.activation_checks`, replay `DUPLICATE` y estado `TERMINAL`. | `PASS / ISOLATED (PG17 real)` |
| `JOINT-01` | Commit atómico agregado/Outbox, `relayCatalogDelivery` con fallo ambiguo (`RETRY`) + recuperación (`CONFIRMED`) sobre doble Azure Service Bus, consumo de Pricing+Inventory y activación real `ACTIVO` en `catalog.products`. | `PASS / ISOLATED (PG17 real)` |
| `JOINT-01-REGRESSION` | Residuo previo con `causation_id` ajeno → `STALE`; `correlation_id` falsificado con `causation_id` activo → `InvalidCatalogMessage`. | `PASS / ISOLATED (PG17 real)` |
| `BULK-JOINT` y `BULK-CONSUMER-v2` | `createCatalogBulkConsumer` → `CatalogBulkService.consume` (schema v2) en `catalog.products`/`sku_identity`/`outbox`, replay `DUPLICATE`, rechazo real `SKU_DUPLICADO` por constraint UNIQUE de PG17 y bloqueo si `g6.bulk.from.catalog` está deshabilitado. | `PASS / ISOLATED (PG17 real)` |
