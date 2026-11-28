# Auditoría CI H5 — Backend (en curso)

Referencia de diagnóstico: `77769106095479d071904eaecea25e994ce9d962`;
[CI 46103267151](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/46103267151): **FAIL**.
El job Combos PostgreSQL H5 tuvo 2 PASS y 2 FAIL, sin omisiones. `validate` y el contexto heredado fallaron. El resultado no acredita los cambios locales posteriores.

En el árbol local sin commit, una repetición con PostgreSQL 17 descartable, TLS y rol runtime no propietario pasó 4/4 tras corregir el orden temporal de las fixtures. Fue un harness adaptado a Windows; falta ejecutar el harness Linux y el CI sobre el HEAD publicado.

Trabajo local posterior: el job `e2e` selecciona `CATALOG_POSTGRES_ONLY=1` y excluye suites AMQP listadas; seis pruebas de Catalog se omiten explícitamente en ese modo. La selección estructural se prueba con negativos, pero todavía no se ha ejecutado la suite PostgreSQL completa con ese modo ni se ha acreditado equivalencia integral de los escenarios omitidos. El job separado `taxonomia` invoca `run-taxonomy-integration.mjs`, que todavía incluye dos pruebas de RabbitMQ real: el retiro de RabbitMQ de todos los gates H5 sigue pendiente.

Estas dos pruebas no son dobles ni simples pruebas de flags: `procesa los tres maestros por RabbitMQ real sin duplicar Inbox ni Outbox` y `recupera una entrega sin ACK al reiniciar, sin duplicar efectos, con RabbitMQ real aislado` llaman a `RabbitTaxonomyDesechable.iniciar()`. El runner obligatorio rechaza pruebas omitidas. La suite `taxonomia_catalogo` acredita barreras y mensajería H5 aisladas, pero no sustituye por sí sola la totalidad de estas garantías H4; no se han eliminado silenciosamente. `scripts/ci/h5-e2e-policy.test.mjs` registra esta deuda y verifica que no se confunda con ausencia de broker real.

| Caso H4 separado | Evidencia H5 disponible | Límite de equivalencia |
|---|---|---|
| TAXONOMY-UPDATES | `taxonomia_catalogo`: `run-taxonomy-catalog-postgres.mjs` | R09/R18 y barreras cubiertas; ACK/reinicio de actualizaciones de Catalog no demostrado equivalente |
| BULK-JOINT y BULK-CONSUMER-v2 | `bulk_postgres_h5`: `r03-pricing-r14-bulk.postgres.e2e-spec.ts` | Conciliación R03/R14 y replay parcial; ingestión extremo a extremo de Catalog no demostrada equivalente |
| JOINT-01 / JOINT-01-REGRESSION / BLOCK-A2 | Suites PostgreSQL de Catalog, Pricing e Inventory H5 | Las pruebas aisladas no acreditan todos los recorridos de recuperación, autenticación y concurrencia del broker histórico |

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

El job E2E general ejecutó `apps/catalog-svc/test/rabbitmq.e2e-spec.ts` (7 pruebas) y los casos `BULK-JOINT` y `BULK-CONSUMER-v2` de `apps/catalog-svc/test/postgres.persistence.e2e-spec.ts`, ambos con RabbitMQ y PostgreSQL: [log del job](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/46103267151/job/140850279060). La segunda suite invoca `jointBroker.start()` incondicionalmente en `beforeAll`; `TAXONOMY-UPDATES`, `JOINT-01`, `JOINT-01-REGRESSION` y `BLOCK-A2` también usan un broker real. Excluir solo el archivo RabbitMQ no elimina ese arranque; excluir la suite PostgreSQL completa perdería también pruebas no relacionadas. Los escenarios de broker necesitan sustitutos H5 verificados y selección que detecte omisiones antes de retirarlos del gate. `bulk_postgres_h5` cubre R03/R14 y `taxonomia_catalogo` cubre barreras y outboxes R09/R18, pero no acreditan por sí solos equivalencia íntegra de esos recorridos Catalog/Bulk/Inventory. La selección local propuesta retira esos recorridos del job general; no se ha publicado y sus sustitutos no están verificados. Los datos locales y dobles no acreditan ASB ni G7 reales. Trivy 0.76.2 procesó nueve imágenes del SHA de diagnóstico sin hallazgos HIGH/CRITICAL en los reportes inspeccionados; no certifica imágenes de otro SHA. No se verificaron las alertas CodeQL ni la configuración predeterminada por falta de acceso a la API. Performance integral de nueve servicios: no acreditado.

Los YAML de CD protegidos no presentan diferencias frente a master en el PR de diagnóstico. Esta inspección no sustituye la revisión de scripts compartidos ni autoriza despliegues.
