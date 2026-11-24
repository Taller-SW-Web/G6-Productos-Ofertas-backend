# HANDOFF — G6-H5-F Fases 4 y 5: fixtures aisladas y preparación de release

Fecha: 2026-11-24 (America/Lima)
Backend base sincronizada: `origin/master` `49bab9e2075819d922c63b06fcc6fc6ac16ce703` (PR #273 mergeado).
Docs `origin/master` revisado: `c9e1e5c217616d28229fccf5315fb97a1ae061a9`.
Rama de trabajo: `trabajo/castilla/h5-fixtures-integracion-g5`.
Draft PR: [#275](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/pull/275), abierto contra `master`.
HEAD inicial de implementación publicado: `f3b3ebf1ca86d519d39d8907cc5a461cfe67c3e0`.
Freeze Chile: `AZURE_CHILE_DEPLOY_ENABLED=false`, según evidencia operativa previa; no se cambió.

## Resumen ejecutivo

Se convirtió el plan de fixtures en un harness local PostgreSQL 17.11 para lifecycle de Inventory, se reforzaron pruebas de la frontera Promotions G5, se documentó reconciliación del ledger con checksums observados y se preparó una secuencia SQL real marcada review-only. Los cambios no hacen DDL/DML/GRANT contra Supabase compartido. No hubo cambios de Azure, ACA, Service Bus, Marketplace o migraciones reales.

Pruebas de Promotions enfocadas pasan: 40 unitarias y 12 PostgreSQL. El harness PostgreSQL usa un login runtime no superusuario y confirmó cleanup. La prueba lifecycle de Inventory ahora pasó completa en PostgreSQL 17.11: SKU base/variante, idempotencia, preservación de versión superior, rechazo atómico (incluye identidad huérfana y overflow), timestamp a milisegundo, invariantes de stock y grants runtime. La primera ejecución detectó una aserción de test que asumía un solo rechazo aunque seguía presente el SKU sintético fuera de rango; se corrigió para comprobar ambos motivos y se repitió con éxito. En ambas pruebas Docker se eliminó solo el contenedor etiquetado de la ejecución y se confirmó cleanup. La integración Inventory existente de 62 pruebas permanece como regresión local separada.

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

Usos concretos de `VENTAS` inspeccionados: `src/http/http-contract.generated.ts` lo admite en el query `canal` de `GET /api/v1/promociones` y en respuestas/listas de canales de promoción; `src/domain/promotion-rules.ts` lo admite para `enabled_channels`; `src/coupons/assigned-projections.ts` lo admite para la proyección interna de precio; `src/coupons/assigned-h4-contract.generated.ts` conserva el enum histórico de mensajes asignados. Esos campos son configuración/canal de lectura o proyección y concuerdan con los enums físicos auditados. La frontera del snapshot G5 está en `src/coupons/coupon-contract.generated.ts`, `g5-coupon-snapshot.schema.json` y `g5-coupon-snapshot.ts`, donde los tres canales comerciales explícitos excluyen VENTAS; `migrations-candidate/h5/0001_coupon_http_operations.sql` reserva `source_client_id='modulo-ventas'` como identidad técnica. No se halló un productor H5 que intercambie dichos valores; no se modificaron contratos ni lógica productiva.

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
| Lifecycle, SKU base/variante y grants Inventory | Runner PostgreSQL 17.11; overflow y timestamp | PASS: backfill y aserciones, cleanup confirmado |
| Inventory comportamiento (62 casos) | `inventory.real.integration.spec.ts`, integración local | PASS en ejecución previa; no es G5/G7 bilateral |
| Promotions G5 snapshot/channel | 2 archivos Vitest | PASS 40/40 |
| Promotions local PG, rol runtime | `run-h5-postgres.mjs` | PASS 12/12 en esta reanudación; cleanup confirmado |
| Simulación G5/G7 | test local Promotions con snapshot/token dobles | PASS como simulación solamente |
| PostgreSQL reconstruible lifecycle | runner con contenedor/etiqueta únicos | PASS: dos ejecuciones desechables; en la segunda también confirmó rebuild y cleanup |
| Supabase real, migraciones, grants, fixtures | prohibido en esta intervención | NOT_RUN |

No se copiarán datos de clientes ni productos Marketplace. G5 fixture snapshots son sintéticos; IDs aleatorios en pruebas de operación reducen colisiones entre repeticiones. Escenarios con la misma orden/reserva/cupón/TTL/worker/MessageId son exclusivos; lecturas sin side effects y registros completamente disjuntos pueden concurrir en local.

Cobertura aún no unificada: el runner Inventory prepara Catalog product/variant, ubicación, stock y lifecycle, mientras Promotions corre en su propio PostgreSQL desechable con promoción/cupón y snapshot contractual. No existe todavía un único seed ejecutable que incluya `pricing.prices`/`price_validities` y `inventory.commercial_fulfillment_routes` junto con todos esos contextos. Los tests funcionales por servicio pasan, pero la fixture comercial G5 completa y conectada queda como parte pendiente de preparación; no se afirma aislamiento ni integración cross-service completa por el manifest sintético.

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
- `node apps/promotions-svc/test/run-h5-postgres.mjs`: PASS 12/12 y `DISPOSABLE_POSTGRES_CLEANUP_CONFIRMED` en esta reanudación.
- Inventory integration `INVENTORY_REAL_INTEGRATION=1 ... inventory.real.integration.spec.ts`: PASS 62/62, ejecutado previamente en PostgreSQL/RabbitMQ local disposable, regresión H4 aislada.
- PowerShell parser de los dos scripts lifecycle, lectura estática SQL y `git diff --check`: PASS.
- `pwsh -NoProfile -File ops/supabase/g5-fixtures/tests/run-local-inventory-lifecycle.ps1`: PASS y cleanup confirmado en PostgreSQL 17.11. La primera iteración falló en la expectativa de conteo; tras corregirla para validar rechazo de orphan + overflow, la repetición pasó completa.
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
| FIXTURES_PREPARED | PARTIAL | Harnesses y manifest reproducibles; falta seed integrado de Pricing price-validity y fulfillment route |
| FIXTURES_APPLIED_ISOLATED | PARTIAL | Inventory y Promotions probados en PostgreSQL aislados separados; no hubo base cross-context unificada |
| FIXTURES_FUNCTIONAL_TESTS | PASS | 40 Promotions unit; 12 Promotions PG; lifecycle focused PASS; 62 Inventory Integration anterior. No acredita flujo bilateral G5/G7 |
| FIXTURES_CLEANUP | PASS | Ambos harnesses PostgreSQL imprimieron `DISPOSABLE_POSTGRES_CLEANUP_CONFIRMED` |
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

## Addendum — correcciones finales y repetición PostgreSQL descartable (2026-11-24)

### Evidencia nueva de Supabase y límites

Se toma como evidencia base el handoff directo adjunto por coordinación; no se repitió la auditoría general ni se ejecutó SQL de escritura contra Supabase. La consulta focalizada comunicada por ChatGPT registra 75 identidades SKU (24 base, 51 variantes), 75 versiones positivas en rango, 57 activas según expresión del candidato, 18 inactivas/no vendibles, cero propietarios inválidos, cero lifecycle y cero SKU base no vendible con stock. El candidato no se ejecutó en el proyecto real.

### Correcciones y scripts

- El cuerpo `ops/azure/h5-runtime-preflight/inventory-sku-lifecycle-backfill.candidate.sql` ya no contiene `BEGIN`/`COMMIT`. El generador produce `inventory-sku-lifecycle-apply.transaction.sql` y `inventory-sku-lifecycle-ensayo.transaction.sql`: ambos incluyen `BEGIN`, `SET LOCAL`, precondiciones, cuerpo, postcondiciones, resumen y control transaccional completo; ensayo termina siempre en rollback. Un rechazo levanta excepción con detalle estructurado, por lo que el wrapper no puede tratar `REJECTED_NO_WRITES` como éxito.
- El origen de estados de desactivación se limita a los eventos de Catalog con versión/timestamp autoritativos; modificaciones de producto no relacionadas no alteran el origen. Reactivaciones sin evento autoritativo y estados de variante no derivables se rechazan.
- `05-release-bootstrap-preflight.sql` agrega consultas de metadata de solo lectura para las migraciones necesarias al bootstrap HTTP de Catalog, Inventory, Pricing y Promotions. Como la auditoría compartida no reportó la definición completa de cada objeto físico, no se generó SQL `ALTER/CREATE` de reconciliación para objetos parciales: eso sería una diferencia no probada. El ledger no fue manipulado.
- `ROLLOUT-CHATGPT-SUPABASE.md` documenta los bloques SQL exactos de ensayo/apply y postchecks para revisión futura; no se ejecutó en el conector ni en Supabase real.
- El workflow CI incorpora únicamente el runner focalizado de PostgreSQL desechable para lifecycle; no duplica suites existentes.

### Pruebas repetidas en esta sesión

Docker Server `29.9.3`; imagen PostgreSQL `17.11`:

| Comando | Resultado |
|---|---|
| `pwsh -NoProfile -File ops/supabase/g5-fixtures/tests/run-local-inventory-lifecycle.ps1` | PASS; ensayo/apply simulado, lote mixto atómico, hashes íntegros y `DISPOSABLE_POSTGRES_CLEANUP_CONFIRMED` |
| `node apps/promotions-svc/test/run-h5-postgres.mjs` | PASS 12/12; `DISPOSABLE_POSTGRES_CLEANUP_CONFIRMED` |
| `npx vitest run apps/promotions-svc/src/coupons/coupon-command.spec.ts apps/promotions-svc/src/coupons/g5-coupon-snapshot.spec.ts --maxWorkers=1` | PASS 40/40 |
| `$env:INVENTORY_REAL_INTEGRATION='1'; $env:G6_DOCS_ROOT='...\\docs'; npm test -- apps/inventory-svc/test/inventory.real.integration.spec.ts --reporter=verbose` | PASS 62/62 en PostgreSQL/RabbitMQ local descartable; sin interacción con Service Bus real |

Las pruebas de promociones usan snapshots G5 y respuestas externas simuladas; no son homologación G5/G7. Los harnesses de Inventory y Promotions corren en bases descartables separadas. No se afirmó un recorrido integrado único Catalog→Inventory→Pricing→Promotions: no existe aún un test que ejecute esos servicios/repositorios con un set común de IDs y roles runtime sobre un mismo PostgreSQL. H04 queda `PARTIAL`.

### Runtime, release y smoke

La lectura local de configuración de ACA reportó los logins DB actuales Catalog `catalog_dev_login`, Inventory `inventory_dev_login`, Pricing `pricing_dev_login` y Promotions `promotions_dev_login`, todos del proyecto Supabase activo; los valores de contraseña no se imprimieron ni guardaron. La auditoría directa indicó que son logins de desarrollo con membresía `po_*_dev_runtime`, por lo que no se consideran prueba de identidad/grants de release. El candidato de Inventory conserva `inventory-runtime-grants.proposal.sql`; Promotions conserva `0002_coupon_http_runtime_role.sql`. No se concedieron permisos reales.

La ruta de consulta de operaciones de cupones está protegida por identidad Promotions y requiere audience `api-productos` y scope `cupones:operaciones:leer`, pero el flag H5 efectivo no se consultó en este corte. No se modificó `azure-h5-chile`; Promotions smoke continúa pendiente. Gateway y demás smoke configurados según handoff previo no se alteraron.

El manifiesto de release permanece `PREPARATION_ONLY`; SHAs productivos base corresponden a `49bab9e2075819d922c63b06fcc6fc6ac16ce703`, los digests de nuevas imágenes siguen pendientes. Bootstrap HTTP, activación asíncrona y homologación G5/G7 continúan como gates separados. Esta rama solo cambia candidatos, tests, runbooks y validación CI, no código de microservicios de runtime.

### Estado consolidado

| Control | Estado | Evidencia/pendiente |
|---|---|---|
| `CD_RBAC_VERIFIED` | PASS | Estado anterior aceptado; no repetido |
| `OIDC_AUTH_REAL` | NOT_RUN | No se ejecutó workflow/CD |
| `SMOKE_CONFIGURATION` | PARTIAL | Promotions no configurado; ruta/flag efectivo debe acreditarse en release |
| `SUPABASE_SCHEMA_RECONCILED` | PARTIAL | Preflight estático disponible; falta resultado de comparación física completa |
| `MIGRATION_LEDGER_RECONCILED` | PARTIAL | Checksums históricos documentados; drift físico candidato sin delta verificado |
| `PROMOTIONS_CHANNEL_COMPATIBILITY` | PASS | Canal comercial separado del sender `modulo-ventas`; snapshot rechaza VENTAS |
| `RUNTIME_GRANTS_VERIFIED_LOCAL` | PASS | Harnesses prueban mínimo privilegio en roles aislados; no equivalen al principal de release |
| `FIXTURES_PREPARED` | PARTIAL | Scripts lifecycle/reconciliación y harnesses existentes; fixture integrada de cuatro contextos pendiente |
| `FIXTURES_APPLIED_ISOLATED` | PASS | Lifecycle y Promotions aplicados en PostgreSQL 17.11 desechable, en harnesses independientes |
| `FIXTURES_FUNCTIONAL_TESTS` | PARTIAL | Inventory 62/62, Promotions PG 12/12 y unitarias 40/40; falta camino integrado común de cuatro servicios |
| `FIXTURES_CLEANUP` | PASS | Cleanup confirmado por los runners PostgreSQL repetidos |
| `G5_SIMULATED_INTEGRATION` | PARTIAL | Snapshot doble en pruebas Promotions; sin flujo unificado cross-service |
| `G7_SIMULATED_AUTH` | PARTIAL | Auth simulada en pruebas locales; no demuestra grants/autenticación externa |
| `G5_G7_REAL_HOMOLOGATION` | NOT_RUN | Requiere servicios y evidencia bilateral reales |
| `RELEASE_MANIFEST_PREPARED` | PASS | Manifiesto candidato, SHAs base y digests pendientes |
| `RELEASE_READY` | PARTIAL | Requiere reconciliación del DDL esencial, grants runtime, imagen y smoke protegidos |
| `SERVICE_BUS_READINESS` | PARTIAL | Pruebas locales disponibles; activación y scopes reales siguen en Fase 6 |
| `CHILE_DEPLOY_FREEZE` | PASS | `AZURE_CHILE_DEPLOY_ENABLED=false`; sin despliegues |

No se modificaron Supabase compartido, Azure/ACA, Service Bus, Marketplace, tráfico, secretos ni cuentas. No se ejecutaron grants, migraciones reales, publicaciones, CD, HTTP ni pruebas comerciales. El resultado funcional del retest Marketplace sigue `NOT_VERIFIED` según la evidencia aceptada previamente.

### Publicación en PR #275

La corrección H01–H03, el runner lifecycle integrado en CI y los handoffs se publicaron en la misma rama/PR #275, conservándolo OPEN / Draft. Código publicado en este corte: `772c5807eb0a8d9dae684246396f4a8f0f24bf34`. GitHub PR HEAD verificado igual al commit publicado y `mergeable=true`. Los tres workflows oficiales creados para ese SHA aparecen `completed / skipped` (run IDs `45497989627`, `45497989621`, `45497989520`) porque el PR sigue Draft; no son evidencia de CI SUCCESS. No se solicitó Ready, y no se hizo merge.

## Addendum — evidencia focalizada DDL, lifecycle y cierre del PR (2026-11-24)

Fuente física: `HANDOFF-SUPABASE-G6-H5-DDL-FOCALIZADO.md` del conector Supabase; no se repitió auditoría ni se hicieron operaciones compartidas.

- Inventory lifecycle, offline reconciliation y outbox delivery; Pricing outbox del piloto; Promotions H5 operations/outbox tienen DDL físicamente equivalente a sus candidatos según el handoff. No se generaron tablas duplicadas. El ledger de Inventory 20261104_0001 y los ledgers candidatos H5 siguen sin entrada; se requiere reconciliación versionada por el migrador oficial. Grants son independientes: `inventory_app` carece de INSERT/UPDATE lifecycle y de SELECT/INSERT/UPDATE offline; `po_promotions_runtime` carece SELECT/INSERT/UPDATE sobre las dos tablas H5. No se aplicaron grants.
- Catalog outbox_delivery existe y es equivalente. El delta físico faltante son la función/trigger H5 0001 y `delivery_transport` más su función/trigger 0002. Se preparó `catalog-h5-async-delta.candidate.sql`, copiado de las funciones/triggers canónicos y sin CREATE TABLE, ledger update ni fan-out de filas previas. La prueba desechable dejó cuatro mensajes históricos con cero deliveries y marcó/enrutó solo un nuevo mensaje después de instalar los triggers. `DISPOSABLE_POSTGRES_CLEANUP_CONFIRMED`. Es un delta de Fase 6, no se observó requisito para bootstrap HTTP mientras las flags de mensajería están apagadas.
- Las definiciones/versiones de migración, diferencias y tracks HTTP/Service Bus quedaron en `migrations-reconciliation.md`; `release-manifest.candidate.json` ahora distingue `httpBootstrap`, `asyncActivation` y `g5g7RealHomologation`. La migración Catalog no se volvió gate de HTTP sin prueba de arranque común.

### Lifecycle y pruebas de Inventory

El ensayo/apply se generan desde el cuerpo versionado y la suite compara que ambos archivos contengan exactamente ese cuerpo. La salida incluye un manifiesto JSON determinista de cada fila insertada/avanzada, con estado anterior y posterior, para conservarlo fuera de la transacción tras el apply aprobado. Ensayo termina en rollback, apply solo confirma tras postchecks. La suite local PostgreSQL 17.11 pasó después de estos cambios y confirmó limpieza.

Se añadió prueba de Inventory que inicia con una fila lifecycle version 2, procesa el envelope `catalog.sku.deactivated` contractual version 3, confirma replay deduplicado y preserva stock/reservas. El envelope usa el fixture del contrato de Catalog ya basado en el productor de Catalog. No arranca el servicio Catalog ni captura un mensaje recién producido por `CatalogMutationService` en el mismo proceso/DB; por tanto la prueba de compatibilidad de extremo a extremo productor→handler queda `PARTIAL`, aunque el handler posterior al backfill pasa.

### H06 — logins, roles y permisos (nombres solamente)

| Servicio | Login actual en referencia ACA | Rol heredado/efectivo conocido | Login previsto según plantilla/runtime | Estado de permisos |
|---|---|---|---|---|
| Catalog | `catalog_dev_login` | `po_catalog_dev_runtime` | `catalog_app` (parámetro esperado `G6_EXPECTED_ROLE=catalog_app`) | Actual login es development; grants de release a validar por migration al arrancar. |
| Inventory | `inventory_dev_login` | `po_inventory_dev_runtime` | `inventory_app` | DDL lifecycle/offline coincide; grants mínimos faltan según evidencia directa y la propuesta existente. |
| Pricing | `pricing_dev_login` | `po_pricing_dev_runtime` | `pricing_app` (plantilla `DATABASE_URL`, no se imprime URI) | DDL HTTP separado de outbox; grants de release del servicio requieren validación de ACL. |
| Promotions | `promotions_dev_login` | `po_promotions_dev_runtime` | `po_promotions_runtime` es el rol técnico previsto por la candidata 0002, pero el login release no está acreditado | Rol runtime actual carece SIU en operaciones/outbox; development tiene arw. Candidato 0002 limita H5 a SIU. |
| Gateway | no utiliza PostgreSQL directamente | no aplica | no aplica | no se configuran credenciales de DB para Gateway. |

Los usernames se extrajeron localmente de referencias ACA sin mostrar ni guardar contraseñas. Esta correlación de configuración no asocia sesiones históricas con ACA. Los logins dev actuales no se presentan como identidades aprobadas de release.

### Tracks y estado final

| Control | Estado | Evidencia |
|---|---|---|
| `FIXTURES_LOCAL_INTEGRATED` | PARTIAL | Lifecycle, Inventory y Promotions pasan cada uno en PG17 desechable; aún no existe recorrido común Catalog/Inventory/Pricing/Promotions con IDs compartidos y repositorios/handlers reales. |
| `HTTP_BOOTSTRAP_SCHEMA_READY` | PARTIAL | DDL focalizado equivalente en objetos citados; Inventory ledger ausente, grants lifecycle/offline pendientes y no se completó arranque conjunto. Promotions HTTP H5 requiere sus tablas existentes y permiso runtime. |
| `HTTP_BOOTSTRAP_RUNTIME_GRANTS` | BLOCKED | Falta incorporar/graduar los permisos mínimos de Inventory y Promotions en rollout autorizado; no se aplicó ninguno. |
| `LIFECYCLE_SQL_READY` | PASS | Candidato, generator, manifest before/after, apply/ensayo y suite PG17 exact-body verificadas. |
| `ASYNC_MIGRATIONS_READY` | PARTIAL | Catalog delta candidate local probado y diferido a Fase 6; outbox Inventory/Pricing/Promotions con ledger/flags/grants pendientes. |
| `G5_G7_REAL_HOMOLOGATION` | NOT_RUN | Solo mocks contractuales locales. |
| `CI_OFFICIAL` | NOT_RUN | PR sigue Draft, suites pesadas diferidas. |
| `RELEASE_READY` | PARTIAL | Falta fixture integrada, permisos reales, smoke de Promotions, CI Ready, SHA/digests definitivos y validación operativa. |
| `CHILE_DEPLOY_FREEZE` | PASS | `AZURE_CHILE_DEPLOY_ENABLED=false`; sin Azure/Supabase compartido. |

La prueba integrada H04 permanece pendiente; por ello el PR no se pasó a Ready. No hubo cambios en Marketplace, Supabase compartido, Azure, ACA, Service Bus, escalas, tráfico, ingress, secretos, grants, migraciones ni datos comerciales. No se ejecutaron HTTP ni CD.

### Cierre focalizado H05/H02 — sesión 2026-11-24

Se utilizó el handoff directo `HANDOFF-SUPABASE-G6-H5-DDL-FOCALIZADO.md`; no se repitió la auditoría Supabase. La matriz `migrations-reconciliation.md` ahora separa estado físico, ledger y grants. Inventory lifecycle/offline/outbox, Pricing outbox y Promotions H5 son físicamente equivalentes según esa evidencia; no se agregan `CREATE TABLE`. El delta Catalog (trigger/función de fan-out y marcador `delivery_transport`) queda para Fase 6 y no reenvía los cuatro outbox históricos. El candidato delta se probó localmente en PostgreSQL 17.11 con tabla existente y cuatro mensajes históricos: no produjo deliveries retroactivas y los nuevos eventos sí obtuvieron delivery; cleanup confirmado.

Se agregó una prueba de Inventory que parte de lifecycle inicializado, reserva unidades y procesa/reintenta un envelope contractual `catalog.sku.deactivated` posterior, verificando que cambia lifecycle sin alterar stock/reservas. Es una prueba del handler y replay de Inventory; no captura el evento desde una instancia viva de `CatalogMutationService`, así que la compatibilidad productor→handler sigue parcial.

Validación repetida en esta sesión: lifecycle PostgreSQL 17.11 PASS con wrapper transaccional, rechazo atómico, hashes de todas las tablas protegidas y cleanup; Promotions PostgreSQL 12/12 PASS y cleanup; Promotions unitarias 26/26 PASS; prueba Inventory focalizada 1/1 PASS (62 omitidas por filtro); Catalog delta PostgreSQL PASS y cleanup. Parser PowerShell, JSON, YAML con PyYAML y `git diff --check` PASS. `actionlint` no está instalado. No se ejecutaron CI oficiales: PR continúa Draft.

**H04 permanece pendiente para la siguiente fase de integración.** No se construyó el flujo común con IDs compartidos y repositorios/handlers reales; no se declara integración completa. Tras la redefinición de alcance del coordinador, no es criterio de Ready/CI para #275.

## Cierre de alcance #275 — decisión de coordinación (2026-11-24)

H04 (flujo comercial común Catalog→Inventory→Pricing→Promotions) y la emisión viva Catalog→Inventory se registran como tareas de la siguiente fase de integración, no como criterios de aceptación de este PR. La fixture local independiente y reproducible por bounded context es el alcance de #275. Esto no constituye una afirmación de integración u homologación completa.

La rama incorporó `origin/master` `daf4882b7dc6895c6601a1f4af209ec92c8215b0` mediante merge normal, sin conflictos. Los 13 commits de master observados eran Bulk/Catalog retry integration y pruebas; no invalidaron las candidatas lifecycle, Promotions ni Catalog async. El manifiesto se actualizó a ese SHA como referencia de código; digests siguen pendientes.

Validación repetida tras sincronizar: lifecycle PG17.11 PASS (ensayo rollback, apply simulado, idempotencia, rechazo atómico, hashes de tablas protegidas y runtime mínimo); Promotions unit 26/26; Promotions PG 12/12 con cleanup; Inventory evento contractual focalizado 1/1 (replay y preservación de saldos); Catalog delta futuro-only PASS con cleanup. La primera corrida Catalog coincidió con el shutdown de otro contenedor y falló; se repitió secuencialmente y pasó. JSON, YAML, parser PowerShell y `git diff --check` PASS. actionlint no está instalado. H04 y la emisión Catalog viva permanecen pendientes de fase posterior; G5/G7 real no ejecutado.

En esta versión el PR se mantiene Draft hasta que las correcciones estén publicadas y las CI oficiales pasen; esta nota sustituye cualquier bloqueo histórico que trataba H04 como criterio de #275. No hubo escrituras Supabase real, grants, migraciones, publicación, CD, despliegues, Service Bus ni cambios Marketplace. El gate Chile sigue cerrado.

### Matriz definitiva del alcance de #275

| Criterio | Estado | Evidencia / frontera |
|---|---|---|
| Lifecycle transaccional, ensayo rollback, idempotencia, rechazo atómico, hashes protegidos | PASS | Runner local PostgreSQL 17.11 repetido tras merge de master |
| Pruebas de Inventory lifecycle/evento contractual | PASS | Harness lifecycle y prueba focalizada Inventory 1/1; productor Catalog vivo queda en la siguiente fase |
| Promotions y semántica del canal | PASS | Unitarias 40/40; PG 12/12; `source_client_id` técnico y `channel_id` comercial MARKETPLACE/CHATBOT/RETAIL |
| Matriz DDL y candidatos sin escrituras reales | PASS | Evidencia directa adjunta; ledger y grants separados; no DDL de tablas equivalentes |
| Catalog async delta | PASS local / PHASE 6 | PG17.11 sin replay histórico; no requisito de bootstrap HTTP con flags apagadas |
| Fixtures locales independientes y cleanup | PASS | Inventory lifecycle, Promotions H5 y Catalog delta; todos los harnesses reportan cleanup |
| H04 flujo comercial integrado de cuatro servicios | DEFERRED | Siguiente fase de integración; no aceptación de #275, sin afirmar integración completa |
| Productor Catalog vivo→handler Inventory | DEFERRED | Integración asíncrona futura; no aceptación de #275 |
| Homologación G5/G7 real | NOT_RUN | Fuera de alcance del PR |
| Bootstrap HTTP real / grants reales / release | NOT_RUN | Requiere operación posterior aprobada; no se tocó Supabase compartido |
| CI oficiales | PENDING_READY | Se ejecutarán al pasar #275 a Ready sobre el HEAD publicado |

La tabla anterior es la clasificación vigente del alcance de #275 y reemplaza cualquier nota histórica que trataba H04 como bloqueo de aceptación. El criterio sigue pendiente para la fase de integración.

### Corrección solicitada por CI sobre el primer HEAD Ready

En `c2ba24ebc9bb1763f81190b30a05b81ad5701878`, CI detectó: (1) `format:check` marcó `apps/promotions-svc/test/coupon-h5.postgres.e2e-spec.ts`; (2) en Ubuntu el harness Inventory usaba `$env:TEMP`, vacío, y falló al enlazar el parámetro `Path`. Se corrigieron respectivamente el formato del archivo test y el directorio temporal mediante `[System.IO.Path]::GetTempPath()`. Sin alterar los verificadores, repetí en local lifecycle PG17.11 PASS/cleanup, Catalog delta PASS/cleanup, Promotions PG 12/12/cleanup y unitarias canal/snapshot 40/40. Se publicó la corrección como commit posterior; los workflows deben reevaluarse en su SHA nuevo. Los run IDs del primer HEAD fallido se conservan en la descripción y el registro GitHub: CI `45512807833`; validadores agregados fallaron por esos dos resultados no satisfactorios. Bulk `45512807700` y Pricing/Catalog `45512807822` fueron SUCCESS.
