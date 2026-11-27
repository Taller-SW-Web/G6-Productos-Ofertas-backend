# Inventario de reconciliación Taxonomy R09/R18

Baseline Backend `a30fdfef76a0971fca6078a1f978f848351b53b0`; Docs `f785accbc7c290ba10f873c8f12061405bb2c622` (AsyncAPI/OpenAPI 0.7.0-rc.3); Frontend `deb239867ffde06fbff4ec3d803b4783a356b635`; fork Axel `22667994b970d1ee4b4afdb462797c3cb0a8f43e`. #258 y #276 están integrados; #247 y #264 siguen abiertos. #264 contiene cambios solapados adaptados sobre el master actual; no se modifica ese PR. La migración `0006` de #247 es incompatible y no se toma como base; la versión de esta rama deriva de la candidata integrada por #258.

Migración propuesta `apps/taxonomy-svc/migrations/0006_service_bus_outbox_delivery.sql`: SHA-256 (LF) `ab68c32c188ddbc6b75a07dfe7c5a6a3123d42711ed8bd344277e56b4f3f7f63`. El preflight, guardas, alternativa histórica, reversión y ausencia de backfill se documentan en README.md. No ejecutada en DB compartida.

La clasificación siguiente es para el árbol de esta tarea: PORTAR_ADAPTANDO identifica únicamente archivos cambiados o añadidos; REFERENCIA_TEST son otras pruebas; YA_INTEGRADO se preserva. DESCARTAR_HISTORICO corresponde a los archivos del PR #247 no presentes en master, listados al final. No implica adopción de interfaces nuevas.

| Clase | Archivo |
|---|---|
| YA_INTEGRADO | `apps/taxonomy-svc/README.md` |
| YA_INTEGRADO | `apps/taxonomy-svc/migrations-candidate/h5/0001_outbox_delivery.sql` |
| PORTAR_ADAPTANDO | `apps/taxonomy-svc/migrations-candidate/h5/INVENTARIO_R09_R18.md` |
| PORTAR_ADAPTANDO | `apps/taxonomy-svc/migrations-candidate/h5/README.md` |
| PORTAR_ADAPTANDO | `apps/taxonomy-svc/migrations-candidate/h5/preflight-readonly.sql` |
| YA_INTEGRADO | `apps/taxonomy-svc/migrations/0002_deactivation_source_version.sql` |
| YA_INTEGRADO | `apps/taxonomy-svc/migrations/0003_deactivation_timeout_setting.sql` |
| YA_INTEGRADO | `apps/taxonomy-svc/migrations/0004_product_type_pending_version.sql` |
| YA_INTEGRADO | `apps/taxonomy-svc/migrations/0005_configurable_list_values.sql` |
| PORTAR_ADAPTANDO | `apps/taxonomy-svc/migrations/0006_service_bus_outbox_delivery.sql` |
| REFERENCIA_TEST | `apps/taxonomy-svc/src/bootstrap.spec.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/bootstrap.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/category-seo.controller.ts` |
| REFERENCIA_TEST | `apps/taxonomy-svc/src/config/environment.spec.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/config/environment.ts` |
| PORTAR_ADAPTANDO | `apps/taxonomy-svc/src/config/service-bus.ts` |
| REFERENCIA_TEST | `apps/taxonomy-svc/src/database.spec.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/database.ts` |
| REFERENCIA_TEST | `apps/taxonomy-svc/src/domain/asyncapi-deactivation-compat.spec.ts` |
| REFERENCIA_TEST | `apps/taxonomy-svc/src/domain/brand-logo.spec.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/domain/brand-logo.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/domain/brand-reactivation.service.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/domain/brand-write.service.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/domain/category-create.service.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/domain/category-reactivation.service.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/domain/category-seo.service.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/domain/category-update.service.ts` |
| REFERENCIA_TEST | `apps/taxonomy-svc/src/domain/characteristic-value.service.spec.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/domain/characteristic-value.service.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/domain/characteristic.service.ts` |
| REFERENCIA_TEST | `apps/taxonomy-svc/src/domain/deactivation-check.service.spec.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/domain/deactivation-check.service.ts` |
| PORTAR_ADAPTANDO | `apps/taxonomy-svc/src/domain/deactivation-check.spec.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/domain/deactivation-check.ts` |
| REFERENCIA_TEST | `apps/taxonomy-svc/src/domain/deactivation-integration.ports.spec.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/domain/deactivation-integration.ports.ts` |
| REFERENCIA_TEST | `apps/taxonomy-svc/src/domain/deactivation-intent.service.spec.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/domain/deactivation-intent.service.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/domain/deactivation-timeout.ts` |
| REFERENCIA_TEST | `apps/taxonomy-svc/src/domain/entidades-maestras.dto.spec.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/domain/entidades-maestras.dto.ts` |
| REFERENCIA_TEST | `apps/taxonomy-svc/src/domain/entidades-maestras.spec.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/domain/entidades-maestras.ts` |
| REFERENCIA_TEST | `apps/taxonomy-svc/src/domain/iso-country.spec.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/domain/iso-country.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/domain/master-admin-query.service.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/domain/master-deactivation-request.service.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/domain/product-type-characteristic.service.ts` |
| REFERENCIA_TEST | `apps/taxonomy-svc/src/domain/product-type.service.spec.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/domain/product-type.service.ts` |
| REFERENCIA_TEST | `apps/taxonomy-svc/src/domain/taxonomy-amqp.runtime.spec.ts` |
| PORTAR_ADAPTANDO | `apps/taxonomy-svc/src/domain/taxonomy-amqp.runtime.ts` |
| REFERENCIA_TEST | `apps/taxonomy-svc/src/domain/taxonomy-invariants.spec.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/domain/taxonomy-invariants.ts` |
| PORTAR_ADAPTANDO | `apps/taxonomy-svc/src/domain/taxonomy-service-bus.runtime.spec.ts` |
| PORTAR_ADAPTANDO | `apps/taxonomy-svc/src/domain/taxonomy-service-bus.runtime.ts` |
| REFERENCIA_TEST | `apps/taxonomy-svc/src/errors/problem-details.filter.spec.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/errors/problem-details.filter.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/errors/taxonomy.errors.ts` |
| REFERENCIA_TEST | `apps/taxonomy-svc/src/g7-phase3-trust.spec.ts` |
| PORTAR_ADAPTANDO | `apps/taxonomy-svc/src/health/readiness.controller.spec.ts` |
| PORTAR_ADAPTANDO | `apps/taxonomy-svc/src/health/readiness.controller.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/health/readiness.port.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/infrastructure/brand-logo-storage.ts` |
| REFERENCIA_TEST | `apps/taxonomy-svc/src/logging/sanitized-logger.spec.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/logging/sanitized-logger.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/main.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/persistence/deactivation-source.ts` |
| REFERENCIA_TEST | `apps/taxonomy-svc/src/persistence/drizzle-taxonomy.repository.spec.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/persistence/drizzle-taxonomy.repository.ts` |
| REFERENCIA_TEST | `apps/taxonomy-svc/src/persistence/persistence.providers.spec.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/persistence/persistence.providers.ts` |
| PORTAR_ADAPTANDO | `apps/taxonomy-svc/src/persistence/taxonomy-message.store.ts` |
| REFERENCIA_TEST | `apps/taxonomy-svc/src/persistence/taxonomy.schema.spec.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/persistence/taxonomy.schema.ts` |
| REFERENCIA_TEST | `apps/taxonomy-svc/src/phase1-public-reads.spec.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/phase1-public-reads.ts` |
| REFERENCIA_TEST | `apps/taxonomy-svc/src/postgres-taxonomy.repository.spec.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/postgres-taxonomy.repository.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/private-amqps.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/readiness.controller.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/readiness.ts` |
| REFERENCIA_TEST | `apps/taxonomy-svc/src/taxonomy-admin-query.controller.spec.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/taxonomy-admin-query.controller.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/taxonomy-auth.ts` |
| REFERENCIA_TEST | `apps/taxonomy-svc/src/taxonomy-commercial.guard.spec.ts` |
| REFERENCIA_TEST | `apps/taxonomy-svc/src/taxonomy-masters.controller.spec.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/taxonomy-masters.controller.ts` |
| REFERENCIA_TEST | `apps/taxonomy-svc/src/taxonomy-public-reads.spec.ts` |
| REFERENCIA_TEST | `apps/taxonomy-svc/src/taxonomy-svc.controller.spec.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/taxonomy-svc.controller.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/taxonomy-svc.module.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/taxonomy-svc.service.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/taxonomy-write.controller.ts` |
| REFERENCIA_TEST | `apps/taxonomy-svc/src/taxonomy.controller.spec.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/taxonomy.controller.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/taxonomy.repository.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/taxonomy.schema.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/src/unconfigured-taxonomy.repository.ts` |
| REFERENCIA_TEST | `apps/taxonomy-svc/test/app.e2e-spec.ts` |
| REFERENCIA_TEST | `apps/taxonomy-svc/test/ddl-taxonomy-prueba.ts` |
| REFERENCIA_TEST | `apps/taxonomy-svc/test/e2e-catalog/README.md` |
| REFERENCIA_TEST | `apps/taxonomy-svc/test/e2e-catalog/evidence-catalog-185.json` |
| REFERENCIA_TEST | `apps/taxonomy-svc/test/e2e-catalog/evidence-latest.json` |
| REFERENCIA_TEST | `apps/taxonomy-svc/test/e2e-catalog/evidence.json` |
| REFERENCIA_TEST | `apps/taxonomy-svc/test/e2e-catalog/run.mjs` |
| REFERENCIA_TEST | `apps/taxonomy-svc/test/evidence/config-health-readiness-2026-11-01.unit.json` |
| REFERENCIA_TEST | `apps/taxonomy-svc/test/evidence/issue-34-914dd41.md` |
| REFERENCIA_TEST | `apps/taxonomy-svc/test/evidence/issue-34-postgres-914dd41.json` |
| REFERENCIA_TEST | `apps/taxonomy-svc/test/evidence/issue-34-unit-914dd41.json` |
| REFERENCIA_TEST | `apps/taxonomy-svc/test/evidence/postgres-readonly-2026-10-16.json` |
| REFERENCIA_TEST | `apps/taxonomy-svc/test/evidence/postgres-readonly-2026-11-01.json` |
| REFERENCIA_TEST | `apps/taxonomy-svc/test/evidence/postgres-readonly-2026-11-01.md` |
| REFERENCIA_TEST | `apps/taxonomy-svc/test/fixtures/logo.jpg` |
| REFERENCIA_TEST | `apps/taxonomy-svc/test/fixtures/logo.png` |
| REFERENCIA_TEST | `apps/taxonomy-svc/test/fixtures/logo.webp` |
| REFERENCIA_TEST | `apps/taxonomy-svc/test/persistencia-drizzle.e2e-spec.ts` |
| REFERENCIA_TEST | `apps/taxonomy-svc/test/persistencia-wiring.e2e-spec.ts` |
| REFERENCIA_TEST | `apps/taxonomy-svc/test/postgres-isolation.spec.ts` |
| REFERENCIA_TEST | `apps/taxonomy-svc/test/postgres-isolation.ts` |
| REFERENCIA_TEST | `apps/taxonomy-svc/test/postgres.readonly.e2e-spec.ts` |
| REFERENCIA_TEST | `apps/taxonomy-svc/test/rabbitmq-desechable.ts` |
| REFERENCIA_TEST | `apps/taxonomy-svc/test/readiness.e2e-spec.ts` |
| REFERENCIA_TEST | `apps/taxonomy-svc/test/repositorio-prueba.ts` |
| YA_INTEGRADO | `apps/taxonomy-svc/tsconfig.app.json` |
| REFERENCIA_TEST | `tests/h5/INT06.md` |
| PORTAR_ADAPTANDO | `tests/h5/contract-r18.mjs` |
| REFERENCIA_TEST | `tests/h5/int06-asyncapi.mjs` |
| REFERENCIA_TEST | `tests/h5/int06-cases.json` |
| REFERENCIA_TEST | `tests/h5/int06-contract.e2e-spec.ts` |
| REFERENCIA_TEST | `tests/h5/int06-coverage.json` |
| REFERENCIA_TEST | `tests/h5/int06-evidence.json` |
| REFERENCIA_TEST | `tests/h5/int06-harness.e2e-spec.ts` |
| REFERENCIA_TEST | `tests/h5/int06-http-runner.mjs` |
| REFERENCIA_TEST | `tests/h5/run-int06.mjs` |
| PORTAR_ADAPTANDO | `tests/h5/run-taxonomy-catalog-postgres.mjs` |
| PORTAR_ADAPTANDO | `tests/h5/taxonomy-service-bus.postgres.e2e-spec.ts` |


## DESCARTAR_HISTORICO

- PR #247 `apps/taxonomy-svc/migrations/0006_service_bus_outbox_delivery.sql`: variante incompatible del PR, no confundir con la nueva migración de este árbol ni ejecutar ambas. Verificar checksum y ledger antes de cualquier despliegue.
- PR #247 `apps/taxonomy-svc/src/messaging/*`: runtime alternativo no incorporado; se mantiene el runtime integrado por #258.

## Relación y límites

- R18: Taxonomy → `g6.catalog.from.taxonomy`, seis eventos oficiales; `TAXONOMY_SERVICE_BUS_SEND_ENABLED`, OFF por defecto.
- R09: Catalog → `g6.taxonomy.from.catalog`, `catalog.master.deactivation.checked`; `TAXONOMY_SERVICE_BUS_RECEIVE_ENABLED`, OFF por defecto.
- `TAX-BL02`: owner datos, ledger/permisos/migración en entorno autorizado pendientes. `TAX-BL03`: owner Catalog, homologación y E2E reales pendientes. `TAX-BL04`: owner Axel/Azure, namespace y RBAC reales pendientes. `TAX-BL05`: owner G7, sesiones/grants reales pendientes. T4 y performance: NOT_RUN.
- La referencia `docs_sha` histórica que emite `tests/h5/run-int06.mjs` es `c9e1e5c...`; el contrato de Docs `f785acc...` tiene idéntico SHA-256 `f3331a6630b68039a1d33063000c600ec74db7429d78846da922141101e6c0eb`. No interpretar el campo histórico del runner como el HEAD actual de Docs.

## Corte local provisional de 0006

SHA-256 del archivo de trabajo: `4d0edd7b8347e60bd1ead4558184f9a35b9a14618431c120085cfc3dddece03a`. SQL-CLEAN instala sobre H4; SQL-UPGRADE valida el almacenamiento H5 existente y no realiza backfill. No ejecutar en Supabase compartido. Reversión: detener el runtime, preservar los datos y restaurar desde respaldo validado bajo coordinación del owner; no descartar entregas ni aplicar un rollback destructivo automáticamente. La verificación integral y el SHA publicado siguen pendientes.
