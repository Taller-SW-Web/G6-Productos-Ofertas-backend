# Reconciliación dirigida de migraciones y checksums

Fecha de lectura: 2026-11-24. Backend comparado: `49bab9e2075819d922c63b06fcc6fc6ac16ce703`. Se usan el handoff de auditoría directa de Supabase suministrado por coordinación y una consulta focalizada de solo lectura de `(version, checksum)` de los ocho ledgers. No se alteró ningún ledger.

El migrador de Docs calcula SHA-256 del SQL UTF-8 normalizando CRLF a LF. Los checksums históricos listados abajo coinciden con el archivo versionado bajo esa regla, excepto Inventory 0001: su checksum de servicio es una firma legacy reconocida por `datos/deploy/migrate.py`, no una afirmación de igualdad byte a byte del DDL original perdido. La existencia de objetos sueltos nunca se usa para declarar una migración aplicada.

## Migraciones del ledger de servicio

| Servicio | Migración | Ledger | DDL/runtime | Estado | Acción/orden |
|---|---|---|---|---|---|
| Bulk | 0001 create persistence | 26f461e99631f4126ad99f0811b605f29b7f50aad4c34414ad02b085a2454964 coincide | Ledger observada; checksums comparados | APPLIED_VERIFIED | Ninguna |
| Bulk | 0002 export snapshot | 379d0a16aaf3f7bb28dc81149292f4529317c9767c88616847dda9ded65c5e64 coincide | Ledger observada | APPLIED_VERIFIED | Ninguna |
| Bulk | 0003 export lease | 8aa9308da48861bf77798b68ee2ead6d1923db539d44581bcfec6a24e2436c9f coincide | Ledger observada | APPLIED_VERIFIED | Ninguna |
| Catalog | 0001 create catalog | 5d90c3e3b3cc87c5287c93076830fb95164261ceda493b2a6ea6e6247ab12662 coincide | Ledger observada | APPLIED_VERIFIED | Ninguna |
| Catalog | 0002 SKU barcodes | 640181a757f28a463238261c2bf099c52859d9c3ec3d928cb1371286c283f89f coincide | Ledger observada | APPLIED_VERIFIED | Ninguna |
| Catalog | 0003 publication history | 1329a6ef4e455d9a1888bab394acdbae17b6839bccd38319e452c0571769c18a coincide | Ledger observada | APPLIED_VERIFIED | Ninguna |
| Catalog | 0004 preparation requests | 15c9e95509a36870011855d62a8a71289fbea925f6ba26c0167738cf2647ee02 coincide | Ledger observada | APPLIED_VERIFIED | Ninguna |
| Catalog | 0005 search path | 6841b04ca43d1dc02f5d23735702f68c046d959ade1177ff128078bb5e3435c2 coincide | Ledger observada | APPLIED_VERIFIED | Ninguna |
| Combos | 0001 create persistence | deca86e2768c949c4628c7601c186633029d6b29df5ce7d67aeed2db0c66a14c coincide | Ledger observada | APPLIED_VERIFIED | Ninguna |
| Combos | 0002 creation receipts | No entrada ledger combos; Global ledger registra `g6_combos_0002_creation_receipts` | Tabla reportada físicamente existente; equivalencia completa/servicio ledger no acreditados | DDL_PRESENT_LEDGER_MISSING | No replay. En rama aislada comparar cada columna/index/constraint/function y decidir reconciliación; nunca inventar ledger row. |
| Inventory | 0001 create inventory | b93267e287fbf9245881473beb53c1b5715f132b972348225f3786e2fe9cbb69 legacy signature reconocida, no igualdad fuente | Schema runtime observado; fuente original no certifica binario | PARTIALLY_APPLIED | Conservar histórico; no editar checksum. Cualquier drift requiere migración nueva revisada. |
| Inventory | 0002 order ID / availability | fb34676d4583f6923d04ad2e86acd55857b4a7a63fe3c7b78a61b5ed1bbe148a coincide | Ledger observada | APPLIED_VERIFIED | Ninguna |
| Price Audit | 0001 create | 7d890955717025572da03d258168d81e9b7fa38c797f1b697527f0d4cab89afc coincide | Ledger observada | APPLIED_VERIFIED | Ninguna |
| Price Audit | 0002 typed change | 17092cee56b0889443939584d5935c182c2fc166d1c21e8484c32d6740a534e2 coincide | Ledger observada | APPLIED_VERIFIED | Ninguna |
| Pricing | 0001–0004 | 7f440ffa…c13bc581; a336cb4d…ffeec1d; f13ab851…f7017a559; d40b4aea…ca4c776 (cada hash completo se valida en ledger/query evidence) | Ledger observada y fuentes coincidentes | APPLIED_VERIFIED | Ninguna |
| Promotions | 0001 persistence | ccb75886b2ff993717b46cb923e7983ab4af9038cb1db0af394f997962dac796 coincide | Ledger observada | APPLIED_VERIFIED | Ninguna |
| Promotions | 0002 price projection | ee6c36562c81b6a65682845b01d71c2e10763374c904ea5cb88c9b069f2a5f42 coincide | Ledger observada | APPLIED_VERIFIED | Ninguna |
| Promotions | 0003 timestamps/delete rules | 2e3eaf61ffc96b02d6e6bd25c76dcaded3b9a0c6698e306914811c6c912b0eaa coincide | Ledger observada | APPLIED_VERIFIED | Ninguna |
| Promotions | 0004 coupon receipts | 84a628ee569abbe62524e8874505f3440ce299487d4cba8d1b88647b8743e061 coincide | Ledger observada | APPLIED_VERIFIED | Ninguna |
| Taxonomy | 0001–0005 | 8c71c5b2…c21072; 013f3d9c…c4aeb3; 5aa6ec4a…e7dbea; 1f942340…aee384; 13082f2d…33de46 | Cada migración fuente coincide con checksum de su ledger | APPLIED_VERIFIED | Ninguna |

Las formas abreviadas se usan solo donde los hashes completos se reportan arriba en el handoff de auditoría/consulta sanitizada; no constituyen checksum alternativo.

### Checksum exacto registrado (normalización LF; SHA-256)

```text
bulk 0001_create_bulk_persistence.sql                     26f461e99631f4126ad99f0811b605f29b7f50aad4c34414ad02b085a2454964
bulk 0002_export_source_snapshot.sql                      379d0a16aaf3f7bb28dc81149292f4529317c9767c88616847dda9ded65c5e64
bulk 0003_export_claim_lease.sql                          8aa9308da48861bf77798b68ee2ead6d1923db539d44581bcfec6a24e2436c9f
catalog 0001_create_catalog.sql                           5d90c3e3b3cc87c5287c93076830fb95164261ceda493b2a6ea6e6247ab12662
catalog 0002_create_sku_barcodes.sql                      640181a757f28a463238261c2bf099c52859d9c3ec3d928cb1371286c283f89f
catalog 0003_product_publication_history.sql              1329a6ef4e455d9a1888bab394acdbae17b6839bccd38319e452c0571769c18a
catalog 0004_historical_preparation_requests.sql          15c9e95509a36870011855d62a8a71289fbea925f6ba26c0167738cf2647ee02
catalog 0005_catalog_function_search_path.sql             6841b04ca43d1dc02f5d23735702f68c046d959ade1177ff128078bb5e3435c2
combos 0001_create_combos_persistence.sql                 deca86e2768c949c4628c7601c186633029d6b29df5ce7d67aeed2db0c66a14c
inventory 0001_create_inventory.sql                       b93267e287fbf9245881473beb53c1b5715f132b972348225f3786e2fe9cbb69 (legacy signature; not byte-equivalence)
inventory 0002_order_id_operaciones_disponibilidad.sql    fb34676d4583f6923d04ad2e86acd55857b4a7a63fe3c7b78a61b5ed1bbe148a
price_audit 0001_create_price_audit.sql                  7d890955717025572da03d258168d81e9b7fa38c797f1b697527f0d4cab89afc
price_audit 0002_typed_price_change.sql                  17092cee56b0889443939584d5935c182c2fc166d1c21e8484c32d6740a534e2
pricing 0001_create_pricing.sql                           7f440ffa401e8d56ecb2664060edb131505a16b8568843093a5047a6c13bc581
pricing 0002_schedule_effective_events.sql               a336cb4ddcef8c06cd00ffbea3c84fbd8f6328304fd6f1a997fc53085ffeec1d
pricing 0003_initialization_operation_index.sql           f13ab851c88bdc6a3c35c682151d0074f1894216d084c6f707a3329f7017a559
pricing 0004_price_import_idempotency.sql                d40b4aea677c8938ac3d36f2e5bfb8c5d3530d2522440f0a389343da4ca9c776
promotions 0001_promotions_persistence.sql                ccb75886b2ff993717b46cb923e7983ab4af9038cb1db0af394f997962dac796
promotions 0002_promotions_global_price_projection.sql    ee6c36562c81b6a65682845b01d71c2e10763374c904ea5cb88c9b069f2a5f42
promotions 0003_promotions_timestamps_and_delete_rules.sql 2e3eaf61ffc96b02d6e6bd25c76dcaded3b9a0c6698e306914811c6c912b0eaa
promotions 0004_coupon_idempotency_receipts.sql           84a628ee569abbe62524e8874505f3440ce299487d4cba8d1b88647b8743e061
taxonomy 0001_create_taxonomy.sql                         8c71c5b24c70aedacb59801a3403423a933dae83fdc3aaacc897f0e840c21072
taxonomy 0002_deactivation_source_version.sql            013f3d9c47d3068ab3365d1d581f13ef771f7f26c9b02e5cfd87aaf930c4aeb3
taxonomy 0003_deactivation_timeout_setting.sql           5aa6ec4a2f6cba4b92cd5158b491c62805af89d4d499fedaa15c692bae7dbeea
taxonomy 0004_product_type_pending_version.sql            1f9423406dbc9af914dfcaf77672c3445ed684e6c479639a6fd7a22637aee384
taxonomy 0005_configurable_list_values.sql                13082f2dfe373831b1f3ebf5ec2b096e82d35e45f32a01d8333bc8c64933de46
```

## Candidatas H5 y drift físico

| Servicio / candidata | Ledger particular | Evidencia física focalizada | Estado | Acción segura y dependencias |
|---|---|---|---|---|
| Bulk 0004–0008 | Pendientes | No hay `bulk.outbox_delivery`; el handoff no certifica ausencia de cada otro efecto | PENDING | No aplicar hasta revisar PR #274 y prerequisitos; inventariar cada DDL en branch vacío. |
| Catalog H5 0001 outbox_delivery | Pendiente | `catalog.outbox_delivery` existe, 6 destinos; la columna `delivery_transport` ausente | PARTIALLY_APPLIED | No ejecutar CREATE TABLE candidato. PR #268 y sus dependencias; diseñar migración nueva solo después de diff completo y validar estado entregas. |
| Catalog H5 0002 taxonomy reply transport | Pendiente | No hay evidencia completa equivalente | PENDING | Esperar revisión de Catalog/Taxonomy y no habilitar handler. |
| Catalog H5 0003 | Pendiente | DDL completo no fue certificado en snapshot auditado | PENDING | Reconciliar en rama/instancia aislada antes de aplicación. |
| Combos 0002 receipts | No en ledger combos; sí en ledger global | objeto `combo_creation_receipts` existe | DDL_PRESENT_LEDGER_MISSING | No reejecutar; comparar detalle y usar migración de reconciliación versionada si hay drift. |
| Inventory 20261104_0001 lifecycle/offline reconciliation | Pendiente | Ambas tablas reportadas presentes; exactitud total de constraints/indexes no quedó acreditada por simple existencia | PARTIALLY_APPLIED | El backfill candidato está separado. Para release, comparar objeto completo con archivo antes de cualquier ledger o DDL. |
| Inventory H5 outbox delivery | Pendiente | Tabla `outbox_delivery` presente; equivalencia, incluyendo checks/destinos, debe revisarse | DDL_PRESENT_LEDGER_MISSING | Comparar contra candidato vigente; no repetir DDL ni mutar ledger. |
| Pricing H5 0001 outbox | No en ledger Pricing; piloto en ledger global | Tabla `outbox_delivery` existe, check observado solo `g6.price-audit.from.pricing` | DDL_PRESENT_LEDGER_MISSING | No aplicar CREATE. Verificar destino/check/índices; reconciliar luego de alcance del piloto. |
| Promotions H5 0001 operations/outbox | Pendiente | Ambas tablas e índices principales presentes, pero constraints/grants completos no tienen equivalencia certificada | PARTIALLY_APPLIED | No CREATE. Compara constraints, índices, owner, trigger y columnas en branch aislado; candidato local probado. |
| Promotions H5 0002 runtime grants | Pendiente | `po_promotions_runtime` carece de SELECT/INSERT/UPDATE; development grants sí; rol real ACA no correlacionado de forma concluyente | PENDING | Candidata requiere role elegido explícitamente y hace checks estrictos. No aplicar al shared hasta confirmar identidad exacta de runtime. |
| Taxonomy H5 outbox 0001 | Pendiente | No existe `taxonomy.outbox_delivery` | PENDING | Depende de PR #247/#264, revisar handlers/consumidores y aplicar solo secuencia aprobada. |

## Dependencias de repositorio observadas

En la consulta de PR abiertos, Backend master era `49bab9e2…`. PRs relevantes: #274 (Bulk H5, Draft), #268 (Catalog H5, Draft), #264 (Taxonomy R09/R18), #256 (instrumentación Catalog/Pricing, Draft), #255 (Pricing, Draft), #247 (Taxonomy Service Bus), #259 (corrección docs). No se integran ramas ajenas ni se duplican cambios. El piloto #234 es evidencia aislada Pricing→Price Audit, no habilitación general.

## Orden sugerido, sujeto a comparación exacta

1. Confirmar/aplicar Catalog base y objetos H5 necesarios, sin reejecutar DDL que ya exista.
2. Conciliar y registrar Inventory lifecycle/offline reconciliation; ejecutar primero preflight de backfill y luego backfill revisado, solo en ventana autorizada.
3. Conciliar Promotions H5 tables y runtime grants tras identificar el usuario que usa la ACA.
4. Habilitar Outbox/Inbox por servicio únicamente junto con handler y destino aprobado; Catalog/Inventory/Pricing actuales no implican que todas las entregas estén habilitadas.
5. Bulk y Taxonomy se ordenan después de integrar PRs necesarios y verificar límites/payloads/consumidores.

No existe un caso reportado que necesite estado `CHECKSUM_MISMATCH`: los checksums comparados del ledger histórico coinciden con sus fuentes o están explicitados como firma legacy Inventory 0001. La equivalencia DDL parcial se clasifica por separado.

## Addendum focalizado de DDL y separación HTTP / Service Bus (2026-11-24)

Fuente: `HANDOFF-SUPABASE-G6-H5-DDL-FOCALIZADO.md` adjunto por coordinación. Esta sección usa los metadatos físicos obtenidos directamente; no repite la auditoría general. Las estructuras físicas y los ledgers siguen siendo estados separados.

### Bootstrap HTTP indispensable

| Servicio / objeto | Fuente versionada y SHA-256 normalizado LF | Ledger particular | DDL físico en evidencia focalizada | Acción HTTP |
|---|---|---|---|---|
| Inventory `sku_lifecycle` | `apps/inventory-svc/migrations/20261104_0001_lifecycle_offline_reconciliation.sql`, `2f2e0241e35c884c9889cabe500188787cb9acd588d6956487b20d395bfbb1b2` | No registra esta migración | Estructura equivalente; índices informados y sin triggers | No recrear tabla. Ledger requiere reconciliación versionada oficial. Backfill de datos y grants son pasos separados. |
| Inventory `offline_sale_reconciliations` | Mismo archivo y checksum anterior | No registra esta migración | Columnas, tipos, PK/unique/checks equivalentes; sin defaults/triggers | Sin delta DDL. No falsear ledger. Grants necesarios se informan aparte. |
| Inventory `outbox_delivery` | `apps/inventory-svc/migrations-candidate/h5/0001_outbox_delivery.sql`, SHA-256 `8f2a4da2256dd1150cb6b96d8c135654df006c22cd965584d66a554f879ab3fe` | No registrada en ledger particular | Estructura equivalente al candidato | Fase 6; no prerrequisito HTTP cuando las flags async están apagadas. |
| Pricing `outbox_delivery` | `apps/pricing-svc/migrations-candidate/h5/0001_outbox_delivery.sql`, SHA-256 `1a3c365c7953da0b70ed4977c8c237a5040522c4effd98bfe35bed0e1b5b58be` | No registrada en ledger Pricing; entrada piloto global no es ledger de servicio | Estructura equivalente al piloto, restricción limitada a Price Audit | Fase 6/piloto; no gate HTTP. No ampliar destinos. |
| Promotions `h5_coupon_operations`, `h5_coupon_outbox` | H5 `0001_coupon_http_operations.sql`, SHA-256 `f940a655637a3c23d18c308a5bea5ace18a8803ee80d4f7022eafefe34c1d4f9` | No registradas en ledger particular | Estructuras equivalentes; ambas vacías | No recrear tablas. Son requisito de la operación HTTP H5 de cupones, pero runtime grants se evalúan aparte. |
| Catalog `outbox_delivery` | H5 `0001_outbox_delivery.sql`, SHA-256 `c7404b364c8066250634aadf3bf88b15e186d52f39f4d35ba935706b0ab4d0ed` | Candidata no registrada | Tabla equivalente; faltan `enqueue_h5_outbox_deliveries()` y `tr_catalog_outbox_h5_delivery` | No recrear tabla. Diferencia asíncrona; no fan-out/backfill de los cuatro outbox históricos. |
| Catalog `delivery_transport` | H5 `0002_taxonomy_reply_transport.sql`, SHA-256 `a8f1e20cfde665904b7dae7ca45bfdccd36de93514b048878c995651c2ff458b` | Candidata no registrada | Columna, función `mark_taxonomy_reply_transport()` y trigger `trg_catalog_taxonomy_reply_transport` inexistentes | Diferencia asíncrona; ejecutar solo al activar esa integración tras revisar el candidato. |

**Conclusión del bootstrap:** la evidencia focalizada no muestra que Catalog outbox-delivery, Inventory outbox-delivery, Pricing outbox-delivery o Catalog `delivery_transport` sean necesarios para iniciar el camino HTTP apagando mensajería. Inventory lifecycle/offline reconciliation sí se requieren para la capacidad Inventory y sus grants/backfill se preparan separadamente. Las dos tablas H5 Promotions ya existen y no se deben recrear. La comprobación de arranque HTTP de los cuatro servicios sobre una única fixture común está pendiente; por ello la conclusión sobre Catalog es estática, no evidencia de un test integrado.

### Ledger y permisos independientes

| Servicio | Estado de ledger | Permisos físicos observados | Próxima acción segura |
|---|---|---|---|
| Inventory | `20261104_0001` ausente pese a DDL equivalente | `inventory_app` hereda `po_inventory_runtime`: SELECT lifecycle; sin INSERT/UPDATE lifecycle ni SELECT/INSERT/UPDATE offline reconciliation | Propuesta existente `inventory-runtime-grants.proposal.sql`. Nueva reconciliación versionada solo por el mecanismo oficial, sin insertar fila histórica sintética. |
| Pricing | H5 outbox no está en ledger de servicio; global piloto no sustituye el ledger | Tabla piloto según evidencia; no ampliar ACL ni destinos | Bootstrap HTTP conserva permisos base; revisar piloto/ledger separado de fase asíncrona. |
| Promotions | H5 0001/0002 no están en ledger de servicio | `po_promotions_runtime` carece SELECT/INSERT/UPDATE en tablas H5; development role posee arw | No aplicar grants dev automáticamente. Resolver rol de release y aplicar candidato 0002 solo en rollout aprobado. |
| Catalog | H5 0001/0002 no están en ledger de servicio | ACL por columna y rol reportados; verificar UPDATE por columna para fase async | El delta futuro no toca las cuatro filas históricas ni altera ledger antiguo. |

Los estados físicos no significan que el migration runner haya registrado las candidatas. No se modifica checksum ni ledger en esta rama.

### Service Bus — fase posterior

Catalog conserva las cuatro filas `catalog.outbox` no publicadas y cero entregas. Las candidatas canónicas H5 0001/0002 son fuente para el fan-out futuro y la marca de transporte. Si se prepara un delta, deberá verificar la tabla existente y no recrearla; instalar solo funciones/triggers/columna canónicos faltantes; no recorrer ni reenviar mensajes históricos ni crear entregas retroactivas; no modificar el ledger; y ejecutarse solo en Fase 6, tras congelar writer H4 y aprobar la activación.

Inventory y Pricing outbox, y Promotions operations/outbox, no son prerrequisitos globales de bootstrap HTTP. Productores, consumidores, roles Sender/Receiver y activación quedan en la secuencia de Fase 6.
