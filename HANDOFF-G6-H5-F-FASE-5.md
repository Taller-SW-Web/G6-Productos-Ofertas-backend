# HANDOFF — G6-H5-F Fases 4 y 5: fixtures aisladas y preparación de release

Fecha: 2026-11-24 (America/Lima)
Backend base sincronizada: `origin/master` `49bab9e2075819d922c63b06fcc6fc6ac16ce703` (PR #273 mergeado).
Docs `origin/master` revisado: `c9e1e5c217616d28229fccf5315fb97a1ae061a9`.
Rama de trabajo: `trabajo/castilla/h5-fixtures-integracion-g5`.
Draft PR: [#275](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/pull/275), abierto contra `master`.  
HEAD publicado: `f3b3ebf1ca86d519d39d8907cc5a461cfe67c3e0`.  
Freeze Chile: `AZURE_CHILE_DEPLOY_ENABLED=false`, según evidencia operativa previa; no se cambió.

## Resumen ejecutivo

Se convirtió el plan de fixtures en un harness local PostgreSQL 17.11 para lifecycle de Inventory, se reforzaron pruebas de la frontera Promotions G5, se documentó reconciliación del ledger con checksums observados y se preparó una secuencia SQL real marcada review-only. Los cambios no hacen DDL/DML/GRANT contra Supabase compartido. No hubo cambios de Azure, ACA, Service Bus, Marketplace o migraciones reales.

Pruebas de Promotions enfocadas pasan: 40 unitarias; el harness PostgreSQL H5 con login runtime no superusuario había pasado 12 pruebas y confirmó cleanup en una ejecución aislada previa a esta reanudación. El test de Inventory lifecycle extiende cobertura de base SKU, variante, idempotencia, rechazo atómico, versión posterior, timestamp a milisegundo y grants mínimos. En este intento no se pudo volver a ejecutar: Docker Desktop devuelve HTTP 500 en `containers/json`, y no hay PostgreSQL local alternativo instalado. La versión anterior del test lifecycle y la integración Inventory real de 62 pruebas se ejecutaron con éxito en el trabajo previo; las nuevas aserciones quedan pendientes de ejecución por la indisponibilidad del engine.

## Evidencia Supabase usada y límites

Fuente primaria: `HANDOFF-SUPABASE-G6-H5-AUDITORIA-DIRECTA.md` entregado por coordinación; una lectura puntual adicional del ledger obtuvo `(version, checksum)` en los ocho schemas, solo lectura. Proyecto y datos no se escribieron. Los checksums de migraciones históricas comparables coinciden con las fuentes bajo normalización LF, salvo Inventory 0001 cuya firma legacy no certifica igualdad del DDL original. Los ledgers de cada servicio se conservaron separados del ledger global.

Hallazgos directos relevantes preservados: 110 balances/55 SKU/0 lifecycle; los 110 resuelven desde `catalog.sku_identity` (102 variante, 8 base); lifecycle usa versión positiva `integer`; `stock_balance.available` es generada. El rol `inventory_app` necesita permisos lifecycle/offline reconciliation definidos en el proposal existente. Promotions H5 operations/outbox existen pero carecen de grants para runtime; el candidato 0002 es el mecanismo a revisar tras confirmar rol exacto. No se ejecutó el rollout real.

Migraciones con DDL presente y ledger particular faltante se clasifican por separado en [matriz de reconciliación](ops/supabase/g5-fixtures/migrations-reconciliation.md). No se inventaron ledger rows ni se reejecutaron tablas existentes. El drift de Catalog (`delivery_transport` ausente) y los objetos H5 de Inventory/Pricing/Promotions se mantienen como gates específicos.

## Backfill Inventory

El candidato `ops/azure/h5-runtime-preflight/inventory-sku-lifecycle-backfill.candidate.sql` se basa en `catalog.sku_identity`, une al propietario base o variante, deriva versión/estado/timestamp del modelo Catalog y no trata `variant_id IS NULL` como huérfano. Inicializa todas las identidades Catalog con transición versionada (no solo las que tienen stock); las identidades draft de versión cero se excluyen si no tienen stock, pero se rechazan si están activas o tienen stock. Esto da cobertura a la proyección autoritativa usada al bloquear futuros SKU inactivos sin inventar transiciones.

El script exige opt-in de sesión, valida owner/parent, stock huérfano, versión dentro de `1..2147483647`, mismatch de producto/estado/versión, rechaza lote sin writes si hay algún problema, es replay-safe y conserva lifecycle de versión más reciente. `changed_at` sigue el formato de Catalog (`Date.toISOString`, milisegundos). Solo modifica `inventory.sku_lifecycle`; no stock, reservas, operaciones, kardex, outbox ni eventos. La reversión requiere snapshot exacto de filas afectadas y no se aplica sobre cambios posteriores.

Scripts: [backfill candidato](ops/azure/h5-runtime-preflight/inventory-sku-lifecycle-backfill.candidate.sql), [fixture Catalog/Inventory](ops/supabase/g5-fixtures/tests/local-inventory-lifecycle-fixtures.sql), [runner aislado](ops/supabase/g5-fixtures/tests/run-local-inventory-lifecycle.ps1), [assertions](ops/supabase/g5-fixtures/tests/test-local-inventory-lifecycle.ps1). Wrapper crea PostgreSQL 17.11 aislado con etiqueta propia, no expone puerto y elimina únicamente su propio contenedor. El helper exige etiqueta coincidente antes de reinicializar su base de prueba.

El proposal ya versionado de grants Inventory se reutiliza, no se duplicó: `ops/azure/h5-runtime-preflight/inventory-runtime-grants.proposal.sql`. La prueba realiza operaciones con `inventory_app` login, no superusuario; verifica no-DELETE, no-DDL ni acceso a Catalog. La correspondencia entre username configurado por ACA y rol real de conexión sigue sin poder afirmarse por secreto referenciado.

## Promotions: canal, operaciones H5 y pruebas

Contrato aplicado: `source_client_id`/actor identifica `modulo-ventas`; `channel_id` snapshot conserva canal comercial original `MARKETPLACE|CHATBOT|RETAIL`. No se añadió `VENTAS` a snapshots, `coupon_uses` ni rutas comerciales. Las configuraciones/proyecciones históricas que lo admiten permanecen intactas. La revisión no encontró código H5 productivo que mezcle el actor con `channel_id`; por eso se cambió solo la cobertura: tres canales positivos, `VENTAS`/`UNKNOWN` negativos y rechazo del snapshot `VENTAS` antes de leer Catalog.

El harness `node apps/promotions-svc/test/run-h5-postgres.mjs` usa PostgreSQL 17.11 local, instala candidatos H5 sobre DB descartable vacía y conecta operaciones con `promotions_h5_runtime_test`, login no superusuario miembro de `po_promotions_runtime`. La suite existente verifica operación persistida, idempotencia/conflicto, outbox/relay/inbox/worker, consulta de estado, consumo/restauración, falla G5/dependencias, settlement ambiguo y rechazo de DELETE/DDL. Snapshot de G5 y auth/settlement externo son dobles contractuales; esto no es homologación bilateral. Resultado exitoso de ejecución anterior: 12 pruebas y cleanup confirmado.

No se configuró smoke Promotions: en el corte previo su única ruta GET administrativa `/api/v1/promociones/administracion` estaba en `PUBLIC_READ_ONLY` allowlist. No se cambió configuración ACA ni se enviaron HTTP. Se mantiene pendiente hasta una release con ruta inequívocamente protegida y modo efectivo verificable.

## Matriz de estado de migraciones

| Servicio | Estado resumido | Gate |
|---|---|---|
| Bulk | 0001–0003 `APPLIED_VERIFIED`; H5 0004–0008 `PENDING`; no outbox_delivery | PR #274, auditar cada DDL antes de aplicar |
| Catalog | 0001–0005 `APPLIED_VERIFIED`; H5 0001 `PARTIALLY_APPLIED`; otras candidatas `PENDING` | PR #268; `delivery_transport` ausente, no ejecutar CREATE repetido |
| Combos | 0001 `APPLIED_VERIFIED`; 0002 `DDL_PRESENT_LEDGER_MISSING` (global entry only) | Comparación completa/ledger servicio, sin recrear |
| Inventory | 0001 legacy `PARTIALLY_APPLIED`; 0002 `APPLIED_VERIFIED`; lifecycle/outbox `PARTIALLY_APPLIED` o `DDL_PRESENT_LEDGER_MISSING` según objeto | DDL exacto y lifecycle antes de release; no ledger injection |
| Price Audit | 0001–0002 `APPLIED_VERIFIED` | Ninguno base |
| Pricing | 0001–0004 `APPLIED_VERIFIED`; outbox `DDL_PRESENT_LEDGER_MISSING` y restringido al piloto Price Audit | PR #255/#256 según cambios; no asumir H5 general |
| Promotions | 0001–0004 `APPLIED_VERIFIED`; operations/outbox `PARTIALLY_APPLIED`; grants `PENDING` | Confirmar runtime principal y DDL exactos |
| Taxonomy | 0001–0005 `APPLIED_VERIFIED`; outbox `PENDING` | PR #247/#264 y handlers antes de habilitar |

No hay `CHECKSUM_MISMATCH` confirmado. `migrations-reconciliation.md` incluye checksums observados y acciones seguras. No se preparó reconciliación que reejecute DDL porque no hay prueba completa de igualdad ni ventana real; una diferencia requerirá migración nueva, nunca modificación histórica.

## Fixtures aisladas y suites

| Capacidad | Artefacto/evidencia | Resultado |
|---|---|---|
| Lifecycle, SKU base/variante y grants Inventory | Runner PostgreSQL 17.11; última iteración añade overflow y timestamp | PARTIAL: ejecución más antigua PASS; nuevas aserciones sin rerun por Docker 500 |
| Inventory comportamiento (62 casos) | `inventory.real.integration.spec.ts`, integración local | PASS en ejecución previa; no es G5/G7 bilateral |
| Promotions G5 snapshot/channel | 2 archivos Vitest | PASS 40/40 |
| Promotions local PG, rol runtime | `run-h5-postgres.mjs` | PASS 12/12 en ejecución previa; cleanup confirmado |
| Simulación G5/G7 | test local Promotions con snapshot/token dobles | PASS como simulación solamente |
| PostgreSQL re-reconstructibilidad lifecycle | runner con contenedor/etiqueta únicos | No confirmada en este turno; Docker Desktop API 500 impidió repetición |
| Supabase real, migraciones, grants, fixtures | prohibido en esta intervención | NOT_RUN |

No se copiarán datos de clientes ni productos Marketplace. G5 fixture snapshots son sintéticos; IDs aleatorios en pruebas de operación reducen colisiones entre repeticiones. Escenarios con la misma orden/reserva/cupón/TTL/worker/MessageId son exclusivos; lecturas sin side effects y registros completamente disjuntos pueden concurrir en local.

## Release de cinco servicios (manifiesto candidato, sin publicar)

El único SHA común del código actualmente integrado para inspección es `49bab9e2075819d922c63b06fcc6fc6ac16ce703`. Los cambios de esta rama son fixture/tests/candidato SQL y no cambian imagen productiva. Por ello, ese SHA es baseline de auditoría, no declaración de release aprobada. Los digests nuevos permanecen `PENDING`; ningún digest histórico se reasigna a código nuevo.

| Servicio | SHA/candidato | PR/dependencia | Migración/runtime | Readiness, seguridad, smoke y rollback |
|---|---|---|---|---|
| Catalog | Baseline `49bab9e2…`; build/digest pendiente | #268 (H5 integración/performance) y cualquier revisión habilitante | Catálogo es fuente de SKU/version; reconciliation H5 outbox y `delivery_transport` antes de activar handlers; identidad DB Catalog no re-auditada aquí | Conservar endpoints/readiness existentes; outbox no equivale a transporte activo; rollback a digest anotado, sin reverting esquema destructivo |
| Inventory | Baseline `49bab9e2…`; build/digest pendiente | No se reabren PR ajenos; aplicar lifecycle/grants solo tras SQL revisión separada | Requiere reconcile lifecycle/offline/outbox y backfill; `inventory_app` proposal; G7 `userBearer` reservado para API externa | Liveness/readiness existentes; smoke protegido documentado previo; rollback de app no revierte datos lifecycle y exige preservar eventos posteriores |
| Pricing | Baseline `49bab9e2…`; build/digest pendiente | #255 CSV OpenAPI y #256 instrumentación son pendientes de review/integración según alcance | Outbox físico limitado al piloto Price Audit; identidad/config DB y flags requieren receipt | `GET /api/v1/precios` smoke estaba configurado previamente; rollback por digest; confirmar código/config compatibles |
| Promotions | Baseline `49bab9e2…`; build/digest pendiente | Tests de este Draft no constituyen merge productivo; cambios de contrato quedan fuera | Tablas H5 ya existentes; DDL equivalente y runtime grants no reconciliados; actor modulo-ventas vs canal snapshot | No smoke protegido confirmado (ruta actual pública); requiere configuración segura futura; rollback por digest y operaciones durables |
| Gateway | Baseline `49bab9e2…`; build/digest pendiente | Revisión transversal, no PR gateway independiente identificado | Depende contratos/paths/seguridad y disponibilidad de los servicios; no concede lógica de negocio | Smoke Gateway previo está configurado; API externa `userBearer`/G7; rollback primero/último según rutas revertidas |

Secuencia implementable: (1) Catalog con sus consumidores de transición todavía desactivados hasta destinos preparados; (2) Inventory y Pricing en releases coordinados después de schema/grants/lifecycle; (3) Promotions después de Inventory reservation evidence, Catalog SKU y Pricing effective data; (4) Gateway al final de la compatibilidad de rutas. Los cortes solo se secuencian si contratos y digest de cada dependencia son compatibles. Ningún microservicio se despliega por esta matriz. Los otros cuatro servicios existentes —Bulk, Combos, Price Audit y Taxonomy— no reciben cambios/despliegues; se mantiene su runtime y se bloquean flujos no migrados.

Para cada release definitivo faltan: PRs revisados/mergeados que cambien código, CI sobre SHA exacto, imagen nueva publicada y digest GHCR/OCI verificado, runtime config/identity comprobada por refs sin revelar secretos, grants DB, gates `Ready`, HTTP smoke autorizado y rollback receipt probado en ambiente aprobado. Ningún dato se infiere del historial de imagen.

## Service Bus readiness / secuencia Fase 6

| Servicio | Evidencia física/código al corte | Estado y activación futura |
|---|---|---|
| Catalog | `outbox_delivery` con 6 destinos; delivery_transport ausente; PR #268 abierto | No activar productores hasta reconcile/migración, handlers, identidad y prueba por cada destino |
| Inventory | `outbox_delivery` 3 destinos; lifecycle pendiente backfill/grant | No activar producers/consumer hasta esquema, lifecycle y permiso por recurso |
| Pricing | `outbox_delivery` presente, check único `g6.price-audit.from.pricing`; piloto #234 | Solo la ruta piloto está evidenciada; otras colas requieren destinatario/handler y permiso independiente |
| Promotions | tablas H5 HTTP operation/outbox y candidato a `g6.promotions.commands` | Runtime grants y relay/worker/provisionamiento deben reconciliarse; G5 no recibe credenciales SB |
| Bulk | sin `outbox_delivery`; candidatos #274/0004–0008 | Pendiente; limitar payload Basic a 256 KiB efectivo y claim-check/atomicidad antes de activar |
| Taxonomy | sin `outbox_delivery`; candidato #247; #264 | Depende PR, contratos y handler; no activar por tabla/PR solo |

Service Bus Basic no tiene Topics/Subscriptions: outbox por destinatario, Inbox/idempotencia y una cola por consumidor lógico. En Fase 6, roles por recurso/cola: productor `Azure Service Bus Data Sender` en la cola concreta; consumidor `Azure Service Bus Data Receiver` en la cola concreta; no `Data Owner`, namespace-wide ni grants a G5. Primero crear/validar destino y identity scopes, luego habilitar productor, luego consumer/health, observar outbox/inbox/DLQ y solo finalmente homologar. No se activó real ni se leyó/consumió mensaje.

## Validaciones y limitaciones

- `npx vitest run apps/promotions-svc/src/coupons/coupon-command.spec.ts apps/promotions-svc/src/coupons/g5-coupon-snapshot.spec.ts --maxWorkers=1`: PASS, 2 files / 40 tests.
- `node apps/promotions-svc/test/run-h5-postgres.mjs`: PASS 12 tests y cleanup en ejecución anterior documentada en la continuidad; no repetible ahora por Docker Desktop API `500 Internal Server Error`.
- Inventory integration `INVENTORY_REAL_INTEGRATION=1 ... inventory.real.integration.spec.ts`: PASS 62/62, ejecutado previamente en PostgreSQL/RabbitMQ local disposable, regresión H4 aislada.
- PowerShell parser de los dos scripts lifecycle, lectura estática SQL y `git diff --check`: PASS.
- Inventario local/expanded lifecycle: NO EJECUTADO en este intento por Docker API 500 (`/v1.56/containers/json`); no existe `psql`, `postgres`, `initdb` o `pg_ctl` en PATH. No reinicié Docker ni afecté otras sesiones.
- Node instalado `v24.3.0` no satisface el engine declarado `^22.22.3 || >=24.15.0`; tests focalizados ejecutados de todos modos. npm install no modificó manifests/lockfiles.
- No se editaron CI oficiales ni se ejecutaron suites pesadas completas.

## Estado reportado

| Elemento | Estado | Evidencia/pendiente |
|---|---|---|
| CD_RBAC_VERIFIED | PASS | Verificado en Fase 4 previa; sin cambio de RBAC |
| OIDC_AUTH_REAL | NOT_RUN | No CD/dispatch |
| SMOKE_CONFIGURATION | PARTIAL | Gateway/Catalog/Inventory/Pricing previas; Promotions queda pendiente por GET actual público |
| SUPABASE_SCHEMA_RECONCILED | PARTIAL | Audit directa + comparaciones dirigidas; tablas H5 requieren equivalencia completa |
| MIGRATION_LEDGER_RECONCILED | PARTIAL | Checksums históricos; DDL-present/no-ledger y Inventory legacy requieren reconciliación |
| PROMOTIONS_CHANNEL_COMPATIBILITY | PASS | Contrato/tests separan canal original y `modulo-ventas` |
| RUNTIME_GRANTS_VERIFIED_LOCAL | PASS | Logins locales no-superuser prueban permisos mínimos; principal real ACA requiere confirmación |
| FIXTURES_PREPARED | PASS | SQL/test harness reproducibles, manifest/runbook incluidos |
| FIXTURES_APPLIED_ISOLATED | PARTIAL | Promotions local PG y lifecycle previo PASS; nuevas assertions lifecycle pendientes Docker |
| FIXTURES_FUNCTIONAL_TESTS | PASS | 40 Promotions unit; 12 Promotions PG; 62 Inventory Integration anterior. Repetición expanded test pendiente |
| FIXTURES_CLEANUP | PARTIAL | Harnesses anteriores confirmaron cleanup; runner Inventory actualizado no se pudo ejecutar |
| G5_SIMULATED_INTEGRATION | PASS | Snapshot contract double local, no bilateral |
| G7_SIMULATED_AUTH | PASS | Tokens/identidades simulados solo en pruebas localizadas |
| G5_G7_REAL_HOMOLOGATION | NOT_RUN | Requiere servicios/credenciales/evidencia externa autorizada |
| RELEASE_MANIFEST_PREPARED | PASS | SHA base exacto, PRs/migrations/deps/rollback; digests nuevos `PENDING` |
| RELEASE_READY | PARTIAL | Requiere merges/CI/digests/config/grants/smokes definitivos |
| SERVICE_BUS_READINESS | PARTIAL | Matriz de estado y activación preparada, no runtime real |
| CHILE_DEPLOY_FREEZE | PASS | Gate permanece `false`; no se abrió ni cambió |

Marketplace: restauración de escala previamente terminó con código 0 y nueve digests sin cambios; retest funcional continúa `NOT_VERIFIED`. No se alteró.

## Archivos entregables y PR

- Draft PR [#275](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/pull/275), OPEN / Draft / CLEAN; HEAD `f3b3ebf1ca86d519d39d8907cc5a461cfe67c3e0`. No se pasó a Ready ni se fusionó.
- Candidatos y tests bajo `ops/supabase/g5-fixtures/` y `ops/azure/h5-runtime-preflight/`.
- Handoffs actualizados Fase 3/4 y este Fase 5.
- Paquete local sanitizado: `G6-H5-F-Fases-2A-5-sanitizado.zip`. Incluye handoffs 3–5, auditoría directa de Supabase sanitizada, scripts y evidencias; el handoff independiente Fase 2A no estaba disponible en Downloads ni en los worktrees consultados y se marca como ausente en el paquete, no se recrea de memoria.

## Límites

No se cambió Supabase, Azure, ACA, Service Bus, Marketplace, tráfico, secretos, escala, ingress ni datos reales. No se publicó imagen, no se despachó CD, no se ejecutó HTTP, migración, grant o fixture fuera del PostgreSQL disposable anterior. El gate Chile sigue cerrado.
