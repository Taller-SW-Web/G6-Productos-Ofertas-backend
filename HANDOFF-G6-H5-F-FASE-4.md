# HANDOFF — G6-H5-F Fase 4: auditoría Supabase y preparación de fixtures

Fecha: 2026-11-24 (America/Lima)
Backend `origin/master`: `238d809218cae8dbe837ef615d45a91cbec251e1` (merge PR #272).
Alcance ejecutado: auditoría dirigida de solo lectura y preparación de scripts/runbook. No se creó branch Supabase, no se aplicaron migraciones, no se modificaron datos y no se ejecutaron pruebas comerciales.

## Resumen ejecutivo

Se auditó el proyecto Supabase G6 activo y los schemas de Catalog, Inventory, Pricing, Promotions, Combos y Taxonomy. Se prepararon `ops/supabase/g5-fixtures/00-preflight-read-only.sql`, `10-fixture-verification-read-only.sql`, `90-cleanup-preview-read-only.sql` y su procedimiento. Todos son consultas de lectura; los tres SQL usan transacción `READ ONLY` y `ROLLBACK`.

El aislamiento requerido es un **branch de base de datos Supabase dedicado** y servicios de test conectados solo a ese branch. No existe RLS general en los schemas comerciales auditados, por lo que un prefijo `QA` no aísla. La preparación es `PARTIAL`: existe un procedimiento y verificadores read-only, pero no una carga DML lista para aplicar porque el inventario carece de una API aprobada de ajuste, hay que conciliar migraciones/DDL H5 y se debe resolver una discrepancia de canal/rol Promotions primero. No hay decisión pendiente sobre cómo aislar: no escribir sobre la base compartida y usar branch descartable.

## Fuentes y límites

- Backend master en SHA arriba; contratos locales Docs en `C:\Users\marec\Desktop\G6-Productos-Ofertas\docs\contratos\http\openapi.yaml` y matriz G5-H5 de escenarios suministrada por el coordinador (`ESCENARIOS_G5_H5.md`).
- Proyecto Supabase: ref `slzglmtiyrzygpkiuthf`, “Modulo de Productos y Ofertas”, `ACTIVE_HEALTHY`, `sa-east-1`, PostgreSQL `17.11.0.002`.
- Se consultaron metadatos, migraciones registradas y conteos agregados en transacciones read-only. No se consultaron lotes masivos de filas comerciales ni se guardaron credenciales.
- La matriz de escenarios G5-H5-01…20 describe precondiciones/evidencia; no prueba que pedidos, grants, eventos ni ejecución bilateral existan.

## Migraciones y ledger

### Historial global reportado por Supabase

`20261013160902 infra_001_seed_access_roles`; `20261013161315 infra_001_seed_access_owner_grants`; `20261013171410 infra_001_individual_seed_logins`; `20261014205316 crear_identidad_inventory_app_sin_login`; `20261015155734 provision_eight_development_roles`; `20261015155857 complete_eight_development_role_grants`; `20261015155921 grant_taxonomy_dev_schema_usage`; `20261015160009 grant_development_privileges_as_schema_owners`; `20261114050410 g6_combos_0002_creation_receipts`; `20261116171655 h5_pricing_outbox_delivery_pilot`.

### Ledger `schema_migrations` observado por bounded context

| Servicio | Migraciones registradas observadas | Estado frente al código actual / gates |
|---|---|---|
| Catalog | `0001_create_catalog.sql`–`0005_catalog_function_search_path.sql` | Código también contiene candidatas H5 (`migrations-candidate/h5/0001_outbox_delivery.sql`, `0002_taxonomy_reply_transport.sql`). El objeto `catalog.outbox_delivery` existe, pero `catalog.outbox.delivery_transport` no. Comparar checksum/DDL y determinar estado de entrega antes de migrar candidato. |
| Inventory | `0001_create_inventory.sql`, `0002_order_id_operaciones_disponibilidad.sql` | Código contiene `20261104_0001_lifecycle_offline_reconciliation.sql` y candidata H5 `outbox_delivery`. La migración lifecycle no aparece en ledger observado; reconciliar tablas/constraints/checksum, no asumir que falta o está aplicada solo por nombre. `inventory.outbox_delivery` existe. |
| Pricing | `0001_create_pricing.sql`–`0004_price_import_idempotency.sql` | Existe candidata H5 `0001_outbox_delivery.sql`; `pricing.outbox_delivery` existe y el historial global registra piloto `h5_pricing_outbox_delivery_pilot`. Validar equivalencia exacta con la candidata y ledger del servicio antes de reproducir. |
| Promotions | `0001_promotions_persistence.sql`–`0004_coupon_idempotency_receipts.sql` | Candidatas `0001_coupon_http_operations.sql` y `0002_coupon_http_runtime_role.sql`; `h5_coupon_operations`, `h5_coupon_outbox` y `coupon_command_receipts` existen físicamente sin correspondencia clara en el ledger del servicio. Reconciliar propietario, grants, DDL y checksum; no ejecutar candidatas sobre base actual. |
| Combos | `0001_create_combos_persistence.sql` | `combos.combo_creation_receipts` existe; el historial global marca `g6_combos_0002_creation_receipts`. Confirmar branch/ledger/DDL del servicio antes de crear desde cero. |
| Taxonomy | `0001`–`0005` (schema refleja cinco migraciones: creación, versión/desactivación, timeout, versión pendiente, valores de lista configurables) | Código incluye candidata H5 de outbox; `taxonomy.outbox_delivery` no estaba presente en la observación. Requiere dependencia específica de alcance H5 y secuenciación aprobada; no aplicar en esta fase. |

**Regla de migración:** el snapshot no permite clasificar automáticamente cada H5 candidato como “pendiente” ni repetirlo. Hay divergencia entre el ledger de servicio, historial global y objetos físicos. En el branch futuro, capturar DDL/owners/grants/checksums; comparar byte a byte con el candidato y registrar un ledger conciliado antes de aplicar migraciones. H5 outbox candidates no se aplican para escenarios que no usan mensajería.

## Esquema, restricciones y datos agregados

- **Catalog:** products y variants con SKU/slug únicos; identificador SKU global mantiene ownership entre SKU base y variante. Producto requiere nombre, descripción, categoría, tipo, marca, SKU y slug; estado publicado requiere estructura válida y variantes activas cuando corresponda. Conteo observado: productos `ACTIVO=22`, `BORRADOR=2`; variantes `ACTIVA=51`.
- **Inventory:** `stock_balance` PK compuesta `(sku_id, location_id)`, restricciones no negativas y `reserved + blocked <= on_hand`, `available` generado. `locations.code` único. Reservas e `inventory_operations` protegen idempotencia por claves/operation IDs. `sku_lifecycle` vincula SKU con product ID, versión positiva y estado activo. Conteo agregado: 2 ubicaciones activas, 110 saldos. No se actualizó stock.
- **Pricing:** `prices` apunta a exactamente un product o SKU; unicidad de target+channel. Los importes y moneda se alojan en `price_validities`, con versión, vigencia y restricción de no solapamiento. Conteos: 2 precios MARKETPLACE, 9 CHATBOT, 20 con channel NULL.
- **Promotions:** cupones con código normalizado/único y usos únicos por `(order_id,coupon_id)`; scopes de promoción exclusivos a producto o SKU; canales validados. Conteos: promociones 4 activas/6 inactivas; cupones 2 activos/4 inactivos.
- **H5 async:** `catalog.outbox` tenía 4 filas no publicadas en la observación; `catalog.outbox_delivery` no mostraba pendientes. Inventario, Pricing y Promotions outbox no tenían pendientes según consultas focalizadas. `promotions.h5_coupon_operations` tenía 0; `h5_coupon_outbox` 0 no enviados. No leer/alterar/consumir mensajes.
- **RLS:** no habilitado en las tablas comerciales enumeradas, excepto `catalog.historical_preparation_requests` (RLS activado, no FORCE). El aislamiento será la frontera de branch + credenciales/servicios de test exclusivos.

## Discrepancias y dependencias

1. **Canal Promotions `VENTAS`:** contrato HTTP/schema generado enumera `VENTAS`, mientras la restricción `promotions.coupon_uses.channel_id` observada permite `MARKETPLACE`, `CHATBOT`, `RETAIL`. No preparar cupón G5 con `VENTAS` hasta que owner Promotions resuelva la correspondencia contractual/migración en branch. No sustituirlo silenciosamente por otro canal.
2. **Promotions runtime role:** `po_promotions_runtime` tenía USAGE de schema pero no SELECT/INSERT/UPDATE en tablas de operaciones/outbox H5; `po_promotions_dev_runtime` sí tenía esas acciones, sin DELETE/TRUNCATE. Owner Promotions/DBA debe identificar la identidad efectiva de runtime y confirmar grants mínimos en branch antes de escenarios H5. No copiar grants de development a runtime.
3. **Inventario de stock inicial:** no se encontró endpoint comercial autorizado para ajustar saldos. El stock de test debe inicializarse solo dentro del branch descartable con SQL revisado por owner Inventory/DBA, incluyendo location, balance y lifecycle consistente con Catalog (`sku`, `product_id`, `sku_version`). No activar Service Bus ni invocar runtime compartido para sembrar.
4. **G5/G7:** G5 es owner de pedidos, snapshots, pagos/anulaciones y firmas; entrega pedido sintético y snapshot para casos 05/06/17–19. G7 controla JWT/grants y debe proveer identidad sandbox/autorizada. G6 no fabrica datos/credenciales de los otros módulos.
5. **G2:** caso G5-H5-18 requiere contrato/sandbox G2. **Service Bus:** escenario 20 y efectos H5 no se habilitan hasta decisión operativa separada; la fase actual no crea ni activa colas.

## Matriz escenario/concurrencia

| Escenarios | Tratamiento previsto en branch aislado |
|---|---|
| 01–04 | Paralelizables solo con `order_id`, operation/correlation IDs, SKU y unidades de stock no compartidos por caso. Deben ser independientes. |
| 05 → 06 | Secuenciales; mismo pedido, snapshot, reserva y cupón, luego restauración/liberación. |
| 07–08 | Secuenciales; replay y conflicto usan el mismo operation ID original, alterando solo el body negativo en 08. |
| 09 | Exclusivo mientras se reinicia G5 M1 y se reconcilia la intención durable. |
| 10–11 | Exclusivos por reserva/TTL/worker y conciliación. |
| 12 | Exclusivo por carrera entre pago, cancelación y expiración. |
| 13–14 | Consultas/autorización read-only; paralelas con IDs sandbox aislados. |
| 15–16 | Exclusivos por worker/outbox/MessageId y settlement; doble local solo en harness; Service Bus real fuera de este alcance. |
| 17 | Exclusivo por pedido/devolución/reintegro y sandbox G5/G6. |
| 18 | Bloqueado hasta acuerdo y sandbox G2. |
| 19 | Exclusivo por conciliación/cutover de pedido. |
| 20 | Bloqueado hasta autorización de topología/recipientes Service Bus; no ejecutar en esta preparación. |

## Fixtures: plan y scripts

Artefactos agregados bajo `ops/supabase/g5-fixtures/`:

- `00-preflight-read-only.sql`: versión/branch identity, schemas, columnas, constraints, indexes, RLS/policies y objetos outbox/operation.
- `10-fixture-verification-read-only.sql`: verificación por `fixture_product_id` y SKU no secreto, para producto, variante, stock/lifecycle y precio+vigencia.
- `90-cleanup-preview-read-only.sql`: inventario read-only para archivo de evidencia; la limpieza futura es eliminar el branch completo vía control plane Supabase, nunca DML sobre proyecto compartido.
- `README.md`: procedimiento, aislamiento, owners, gates y matriz de concurrencia.

La creación futura usa IDs deterministas únicos por `fixture_run_id`, manifest inmutable y operation UUID estable para cada retry. Catalog/Pricing/Promotions se crean con interfaces autorizadas de sus owners o seed SQL revisado dentro del branch. Inventory requiere SQL seed aislado revisado por owner porque no hay API de ajuste admitida. G5 crea sus pedidos/snapshots; G7 provee tokens/grants. `10-fixture-verification-read-only.sql` es una verificación mínima y se debe contrastar con el DDL exacto del branch antes de ejecutar.

No se creó una sentencia DML de carga: el estado físico/migration ledger aún debe conciliarse y el seed Inventory no puede adivinar el `sku_version` autoritativo de Catalog. El runbook da una secuencia implementable con responsables y condiciones de desbloqueo, y no hace una carga insegura sobre producción.

## Validación de preparación

| Validación | Resultado |
|---|---|
| Revisión de código/migraciones/escenarios locales | PASS, dirigida y solo lectura |
| Consultas de metadatos Supabase en transacción read-only | PASS según evidencia previa de Fase 3B |
| SQL scripts agregados | No ejecutados contra ningún DB; inspección estática pendiente en esta respuesta |
| Migraciones reales | NOT_RUN |
| Branch Supabase descartable | NOT_CREATED |
| DML/fixtures | NOT_RUN |
| Pruebas comerciales G5 | NOT_RUN |

## Estado individual requerido

| Elemento | Estado | Evidencia/pendiente |
|---|---|---|
| ADMIN_PERMISSIONS | PASS | Owner efectivo y acciones Authorization comprobadas; sin cambios a la cuenta |
| PR_272_MERGED | PASS | Merge `238d809218cae8dbe837ef615d45a91cbec251e1`; CI PR y push indicados en handoff Fase 3 |
| CD_RBAC_PLAN | PASS | Plan exacto RG/Environment/UAMI y cinco ACA |
| CD_RBAC_APPLIED | PASS | Dos roles y seis asignaciones; dos scopes finales completados por CLI después de error parcial del script, todos verificados |
| CD_RBAC_VERIFIED | PASS | Acciones/scopes/IDs exactos; sin asignaciones inesperadas para UAMI |
| OIDC_CONFIGURATION | PASS | Federación exclusiva Environment `azure-h5-chile` |
| OIDC_AUTH_REAL | NOT_RUN | No hubo ejecución de CD; sin mecanismo de verificación independiente |
| RUNNER_JIT_READY | PASS | Evidencia previamente aceptada runner 57 y ejecución JIT; no repetida |
| SMOKE_CONFIGURATION | PARTIAL | Catalog, Inventory, Pricing y Gateway configurados; Promotions sin ruta protegida alternativa probada |
| CHILE_DEPLOY_FREEZE | PASS | `AZURE_CHILE_DEPLOY_ENABLED=false`; no se abrió gate |
| SUPABASE_AUDIT | PARTIAL | Metadatos auditados, con reconciliación ledger/schema/roles/canal pendiente |
| FIXTURES_PREPARED | PARTIAL | Procedimiento y verificadores read-only preparados; seed DML pendiente de reconciliación en branch y owner Inventory |
| FIXTURES_APPLIED | NOT_RUN | Ningún branch, migración o dato creado |
| CD_REAL | NOT_RUN | Sin CD/despliegue |

El retest funcional de Marketplace permanece `NOT_VERIFIED`; la restauración previa de escala y estabilidad de digests no se interpreta como resultado funcional. No se modificaron las nueve ACA, Supabase, Service Bus ni recursos Marketplace durante esta fase.

## Addendum — continuación tras auditoría Supabase directa (2026-11-24)

Este addendum reemplaza los bloqueos de preparación de fixtures cuando la evidencia nueva difiera. La evidencia base es el archivo directo `HANDOFF-SUPABASE-G6-H5-AUDITORIA-DIRECTA.md` adjunto por coordinación; no se repitió la auditoría general ni se ejecutaron escrituras remotas.

- Se resolvió semánticamente el límite Promotions sin cambio productivo: `source_client_id`/sender `modulo-ventas` es identidad técnica; snapshot G5 `channel_id` permanece canal comercial original `MARKETPLACE`, `CHATBOT` o `RETAIL`. `VENTAS` no se añadió a snapshots, `coupon_uses` ni rutas. Se mantienen los enums/configuraciones históricas `enabled_channels` y `price_projection` que admiten VENTAS.
- Se añadió un backfill candidato opt-in/replay-safe que toma propietario, versión, estado y timestamp de Catalog por `sku_identity`, cubre SKU base y variantes, no inventa versiones, escribe únicamente lifecycle y rechaza lote ante incompatibilidades. El preflight solo inicializa Catalog SKU con versión válida; no solo los SKU con stock. La precisión timestamp coincide con `Date.toISOString` de Catalog. Nunca se ejecutó en Supabase.
- Se reutiliza `inventory-runtime-grants.proposal.sql`; no se creó una propuesta redundante. Prueba local usa login runtime no superusuario. No se aplicó grant remoto ni se confirmó la identidad real de DB de ACA revelando secretos.
- Se ejecutó lectura focalizada de checksums de los ledgers de ocho servicios. Checksums históricos comparables coinciden con archivos fuente; Inventory 0001 es una firma legacy documentada y no prueba equivalencia byte-for-byte. Los DDL-present/ledger-missing y estados parciales se clasifican individualmente en `ops/supabase/g5-fixtures/migrations-reconciliation.md`; no se agregó fila ficticia ni se reejecutó DDL.
- `ops/supabase/g5-fixtures/README.md` ahora documenta PostgreSQL 17.11 disposable y los harnesses de lifecycle/Promotions; `rollout-real-review-only.md` detalla secuencia/pre-post/rollback y está expresamente marcado no ejecutar. No hay rama Supabase ni fixture real creada.

La suite Promotions unit enfocada pasa 40/40. El harness Promotions PostgreSQL había pasado 12/12 y confirmó cleanup en una ejecución aislada anterior. El intento actualizado de lifecycle no se pudo repetir ahora: Docker Desktop API devuelve `500 Internal Server Error` en el endpoint de lista de contenedores y no hay `psql`/PostgreSQL en PATH; nuevas aserciones de timestamp/overflow quedan pendientes. Evidencias y estados están en `HANDOFF-G6-H5-F-FASE-5.md`.
