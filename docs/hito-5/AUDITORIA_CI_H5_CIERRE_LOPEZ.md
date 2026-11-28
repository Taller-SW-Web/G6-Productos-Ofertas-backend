# Auditoría CI H5 — cierre técnico Backend

La Coordinación G6 / Marco Castilla comunicó la aprobación técnica de la modernización de CI. El cierre técnico probado corresponde a `6dd66036baf675f8ee2197ab3cb9e9754a0d0886`: [workflow_dispatch 46116008663](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/46116008663) y [pull_request 46119944909](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/46119944909) finalizaron en **SUCCESS**. Una modificación documental posterior identifica un SHA distinto y debe evaluarse con sus propios checks.

| Alcance | Evidencia y límite |
|---|---|
| P0-A | `scripts/ci/h5-e2e-policy.test.mjs`: 5/5 local. El smoke legacy `coupons.isolated.smoke.mjs` se retiró del gate obligatorio; la política verifica la selección sin RabbitMQ real. |
| Taxonomy | Integración local 69/71: dos pruebas H4 preservadas como opt-in; suite H5 Taxonomy–Catalog 24/24. |
| Promotions | Suite PostgreSQL H5 local 15/15. |
| Bulk–Catalog–Inventory | `tests/h5/run-catalog-bulk-inventory-postgres.mjs`: 3/3 local; los imports de orquestación están bajo `tests/h5/`, no entre servicios dentro de `apps/*`. |
| JOINT-01 y regresión | 2/2 local: recuperación, deduplicación y correlación; el resultado Inventory del caso JOINT es una fixture. |
| BLOCK-A2 | Inventory local 2/2: saldos, inicialización, resultados y retorno Inventory–Catalog con redelivery; el campo producer se valida, sin autenticar el principal de Azure. |

Los recorridos aislados usan PostgreSQL descartable y dobles del SDK de Service Bus. No acreditan conectividad, identidad ni permisos RBAC en Azure real. Los YAML protegidos `cd-services-azure.yml` y `publish-only-images.yml` no presentan diferencias frente a la base verificada; esta evidencia no autoriza despliegues.

## Histórico de iteraciones

Las referencias, resultados y afirmaciones de esta sección describen las iteraciones en el momento en que fueron registradas; no representan el estado actual.

# Auditoría CI H5 — Backend

**Estado de la evidencia:** las pruebas H5 descritas en la matriz son resultados locales sobre el árbol de trabajo; el CI del próximo HEAD publicado está pendiente. Los resultados de Actions anteriores son antecedentes históricos. El transporte se prueba con dobles SDK y PostgreSQL descartable; identidad, RBAC y conectividad Azure reales no están acreditados. Los dos YAML protegidos de CD no tienen diferencias frente a `origin/master`.

## Antecedentes históricos

Referencia de diagnóstico: `77769106095479d071904eaecea25e994ce9d962`;
[CI 46103267151](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/46103267151): **FAIL**.
El job Combos PostgreSQL H5 tuvo 2 PASS y 2 FAIL, sin omisiones. `validate` y el contexto heredado fallaron. El resultado no acredita los cambios locales posteriores.

En el árbol local sin commit, una repetición con PostgreSQL 17 descartable, TLS y rol runtime no propietario pasó 4/4 tras corregir el orden temporal de las fixtures. Fue un harness adaptado a Windows; falta ejecutar el harness Linux y el CI sobre el HEAD publicado.

Trabajo local posterior: el job `e2e` selecciona `CATALOG_POSTGRES_ONLY=1` y excluye suites AMQP listadas; seis pruebas de Catalog se omiten explícitamente en ese modo. La selección estructural se prueba con negativos, pero todavía no se ha ejecutado la suite PostgreSQL completa con ese modo ni se ha acreditado equivalencia integral de los escenarios omitidos. El job separado `taxonomia` invoca `run-taxonomy-integration.mjs`, que todavía incluye dos pruebas de RabbitMQ real: el retiro de RabbitMQ de todos los gates H5 sigue pendiente.

Actualización posterior sin commit: las dos pruebas H4 de Taxonomy pasan a opt-in `TAXONOMY_TEST_LEGACY_RABBIT=1`; el runner obligatorio fija `0` y comprueba exactamente sus dos omisiones. El job `taxonomia` requiere `taxonomia_catalogo`. La prueba H5 de R09 fue ampliada para recrear el repositorio tras pérdida de ACK y verificar que la redelivery no duplique Outbox; la suite ampliada pasó 24/24 en PostgreSQL descartable. El runner Taxonomy pasó 69/71 con exactamente dos omisiones H4. Estos resultados son locales y no acreditan un HEAD publicado. El diff de Catalog frente a master pasa de 3.622 líneas de formato a 25 líneas de soporte y comentarios.

En el HEAD publicado `24dd02c`, estas dos pruebas no son dobles ni simples pruebas de flags: `procesa los tres maestros por RabbitMQ real sin duplicar Inbox ni Outbox` y `recupera una entrega sin ACK al reiniciar, sin duplicar efectos, con RabbitMQ real aislado` llaman a `RabbitTaxonomyDesechable.iniciar()`. En ese HEAD el runner rechazaba toda omisión. La versión local separa explícitamente ambas pruebas; sus escenarios H4 siguen disponibles como opt-in. La suite `taxonomia_catalogo` acredita barreras y mensajería H5 aisladas, pero no prueba conectividad con Azure real.

## Matriz de pruebas locales y límites

| Caso H4 separado | Evidencia H5 disponible | Límite de equivalencia |
|---|---|---|
| TAXONOMY-UPDATES | `tests/h5/taxonomy-service-bus.postgres.e2e-spec.ts`: `restarts Catalog receiver after lost ACK for all three taxonomy updates without duplicate inbox effects` | PASS local 24/24: tres Inbox APPLIED visibles antes del ACK, redelivery tras reinicio sin duplicados y payload inválido sin Inbox. En H5 el inválido se envía a dead-letter; SDK simulado, sin Azure real. |
| BULK-JOINT | `tests/h5/catalog-bulk-inventory.postgres.e2e-spec.ts`: `H5 BULK-JOINT: durable Bulk Catalog Bulk round trip and redelivery` | PASS local: Bulk genera y publica el comando v1; Catalog persiste el producto y publica respuesta; Bulk consolida el lote y redeliveries no duplican Inbox. PostgreSQL descartable y doble SDK, no Azure real. |
| BULK-CONSUMER-v2 | `tests/h5/catalog-bulk-inventory.postgres.e2e-spec.ts`: `H5 BULK-CONSUMER-v2: retries Catalog receiver and preserves SKU and batch replay in PostgreSQL`; y prueba H5 BULK-JOINT | PASS local 2/2 focalizadas: el consumidor Catalog v2 resuelve SKU, reintenta y conserva replay; v2 usa productor fixture, como el escenario H4, mientras el ciclo real Bulk usa alta v1. PostgreSQL descartable y doble SDK, no Azure real. |
| JOINT-01 | `apps/catalog-svc/test/postgres.persistence.e2e-spec.ts`: `H5 JOINT-01: durable Inventory result, redelivery and sender recovery` | PASS local (suite focalizada 2/2): relay fallido/reintentado, recepción por doble SDK, estado COMPLETED y una Inbox. La respuesta Inventory es fixture; no acredita el proceso Inventory ni Azure reales. |
| JOINT-01-REGRESSION | `apps/catalog-svc/test/postgres.persistence.e2e-spec.ts`: `H5 JOINT-01-REGRESSION: old delivery cannot hijack fresh correlation` | PASS local (suite focalizada 2/2): entrega previa marcada publicada no secuestra el identificador ni correlación nuevos; emisor doble, PostgreSQL descartable. |
| BLOCK-A2 | `apps/inventory-svc/test/inventory.real.integration.spec.ts`: `H5 BLOCK-A2: initialization preserves balances, rejects invalid locations and replays without duplication` y `tests/h5/catalog-bulk-inventory.postgres.e2e-spec.ts`: `H5 BLOCK-A2: real Inventory results reach Catalog and reject a foreign producer` | PASS local 2/2: Inventory y Catalog reales con PostgreSQL descartable; saldos, inicialización, resultados COMPLETED/REJECTED, replay y rechazo de producer ajeno. SDK doble valida contenido, no autentica principal; RBAC/identidad Azure real permanece pendiente. |
| Taxonomy: tres maestros H4 | `tests/h5/taxonomy-service-bus.postgres.e2e-spec.ts`: resultados R09 CLEAR/IN_USE por entidad, deduplicación y persistencia | Procesamiento H5 aislado probado; la igualdad exhaustiva de todas las aserciones H4 sigue pendiente. |
| Taxonomy: ACK perdido / redelivery H4 | `round-trips a category deactivation`: pérdida de ACK, nuevo repositorio, redelivery e Inbox/Outbox únicos | Prueba H5 aislada 24/24 local, con receptor doble y PostgreSQL real desechable. |

## Antecedentes CI por servicio

| Servicio | Evidencia CI aislada observada | Brecha que queda por acreditar |
|---|---|---|
| Catalog | Taxonomy/Catalog PostgreSQL H5 | Paridad de escenarios del E2E RabbitMQ y filtros de precio |
| Taxonomy | Integración PostgreSQL y Taxonomy/Catalog | Azure real y grants |
| Inventory | PostgreSQL con ocho nombres seleccionados | Casos no seleccionados, transporte y reintentos |
| Pricing | Persistencia PostgreSQL y dobles Service Bus | Azure real y equivalencia H4 |
| Price Audit | Persistencia PostgreSQL y dobles Service Bus | Azure real y equivalencia H4 |
| Promotions | Persistencia TLS y cupones | Redelivery y mensajería real |
| Combos | PostgreSQL H5; 2/4 fallaron | Corregir y volver a ejecutar sobre HEAD nuevo |
| Bulk | R03/R14 PostgreSQL | Equivalencia de recuperación, exportación y mensajería H4 |
| Gateway | Gateway/Inventory PostgreSQL y APIM estático | Autorización y despliegue reales |

**Antecedente histórico P0-A (ya no corresponde al árbol local):** el job obligatorio `promotions` ejecuta `apps/promotions-svc/test/coupons.isolated.smoke.mjs`, que arranca `rabbitmq:4.1-alpine`. La suite `coupon-h5.postgres.e2e-spec.ts` pasó 12/12 localmente con PostgreSQL descartable y dobles SDK; cubre, entre otros, ACK perdido, diez redeliveries, efecto único, recuperación de lease y transacción de Outbox. No se ha demostrado todavía que cubra todos los casos de elegibilidad y eventos asignados del smoke H4, por lo que no se ha retirado ese smoke. El test estructural local falla expresamente mientras el gate lo invoque.

**Antecedente histórico del job E2E.** El job E2E general ejecutó `apps/catalog-svc/test/rabbitmq.e2e-spec.ts` (7 pruebas) y los casos `BULK-JOINT` y `BULK-CONSUMER-v2` de `apps/catalog-svc/test/postgres.persistence.e2e-spec.ts`, ambos con RabbitMQ y PostgreSQL: [log del job](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/46103267151/job/140850279060). La segunda suite invoca `jointBroker.start()` incondicionalmente en `beforeAll`; `TAXONOMY-UPDATES`, `JOINT-01`, `JOINT-01-REGRESSION` y `BLOCK-A2` también usan un broker real. Excluir solo el archivo RabbitMQ no elimina ese arranque; excluir la suite PostgreSQL completa perdería también pruebas no relacionadas. Los escenarios de broker necesitan sustitutos H5 verificados y selección que detecte omisiones antes de retirarlos del gate. `bulk_postgres_h5` cubre R03/R14 y `taxonomia_catalogo` cubre barreras y outboxes R09/R18, pero no acreditan por sí solos equivalencia íntegra de esos recorridos Catalog/Bulk/Inventory. La selección local propuesta retira esos recorridos del job general; no se ha publicado y sus sustitutos no están verificados. Los datos locales y dobles no acreditan ASB ni G7 reales. Trivy 0.76.2 procesó nueve imágenes del SHA de diagnóstico sin hallazgos HIGH/CRITICAL en los reportes inspeccionados; no certifica imágenes de otro SHA. No se verificaron las alertas CodeQL ni la configuración predeterminada por falta de acceso a la API. Performance integral de nueve servicios: no acreditado.

Los YAML de CD protegidos no presentan diferencias frente a master en el PR de diagnóstico. Esta inspección no sustituye la revisión de scripts compartidos ni autoriza despliegues.


### Promotions: avance local de sustitución H5

`node apps/promotions-svc/test/run-h5-postgres.mjs` pasó 15/15 con PostgreSQL 17 descartable. Las pruebas `applies four assigned event projections transactionally with replay, rollback and stale versions` y `enforces coupon eligibility, conflicting combinations, concurrent last use and replay` reutilizan las aserciones del smoke para los cuatro eventos, proyecciones, duplicados y conflicto, rollback, versiones obsoletas, emisor incorrecto, elegibilidad, combinación, límite concurrente y replay. La primera añade redelivery tras ACK perdido usando un doble del SDK Service Bus y receptores recreados; los decodificadores GenericData son fixtures sintéticas y no acreditan homologación ni Azure real.

La prueba `durably consumes and restores through H5 after lost settlements without repeating effects or results` verifica el consumo, la restauración, la conservación del historial, el resultado Outbox persistido y redelivery sin repetir efectos tras perder la confirmación. El job obligatorio ya no ejecuta `coupons.isolated.smoke.mjs`; el archivo sigue disponible para ejecución manual del smoke legacy de RabbitMQ. El doble no demuestra entrega de resultados a un consumidor externo ni reemplaza la homologación Azure real.

Validación local adicional: la suite Bulk R03/R14 pasó 3/3 con `--hookTimeout=60000`; un primer intento con el límite predeterminado falló en `beforeAll` por timeout y omitió los tres casos. Esa suite aislada no demuestra por sí sola la integración real con Catalog; el ciclo conjunto se acredita por la prueba H5 BULK-JOINT indicada en la tabla.
