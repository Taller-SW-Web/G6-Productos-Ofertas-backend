# Instrucción de rollout para el conector Supabase

**Pendiente de ejecución y autorización real.** Esta guía y los SQL adjuntos preparan la operación; no instruyen ejecutar ahora ni cambian la auditoría real aprobada.

## Antes de ejecutar

1. Confirma, desde la propia conexión del conector, el proyecto ref `slzglmtiyrzygpkiuthf`, PostgreSQL 17, usuario efectivo y permisos. No incluyas secretos en la evidencia.
2. Confirma que los objetos Catalog/Inventory necesarios existen y corresponden al contrato. Revisa ledgers particulares por separado; no modifiques ningún ledger.
3. Reconfirma que `catalog.outbox` es legible y que el conjunto de identidades/stock no cambió desde la evidencia auditada. Cualquier rechazo, ambigüedad, drift o permiso faltante detiene la operación.
4. Los únicos datos persistentes permitidos en el paso de aplicación son filas de `inventory.sku_lifecycle`. El script compara el contenido completo, ordenado por PK, de stock, reservas, operaciones, kardex, outbox y conciliaciones offline antes/después.

## Ensayo y aplicación

Cada archivo SQL es una solicitud completa de una sola transacción. Ejecuta el contenido entero como una sola llamada SQL del conector. No ejecutes partes en conexiones separadas ni uses metacomandos psql.

1. **Ensayo primero:** ejecutar exactamente [inventory-sku-lifecycle-ensayo.transaction.sql](inventory-sku-lifecycle-ensayo.transaction.sql). Debe devolver `POSTCHECK_OK` y el resumen. Acaba siempre en `ROLLBACK`; cualquier error significa resultado rechazado. No uses el texto `REJECTED_NO_WRITES` como éxito: las identidades no reconciliables generan excepción y abortan.
2. Revisión humana de salida y aprobación separada para aplicar.
3. **Aplicación solo tras aprobación:** ejecutar exactamente [inventory-sku-lifecycle-apply.transaction.sql](inventory-sku-lifecycle-apply.transaction.sql). Contiene `BEGIN`, `SET LOCAL g6.inventory_sku_lifecycle_backfill='apply'`, preflight, candidato, postcondiciones, resumen y `COMMIT`. Solo llega al `COMMIT` si las verificaciones pasan. Ante error, ejecutar `ROLLBACK` en la sesión activa y detenerse.
4. Adjuntar el resumen sanitizado, que contiene conteos de elegibles, insertadas, avanzadas y conservadas, más verificación de hashes protegidos. No reportar filas con datos comerciales.

Los bloques se regeneran desde el cuerpo único versionado:

```powershell
pwsh -NoProfile -File ops/supabase/g5-fixtures/generate-lifecycle-rollout.ps1
```

El harness `tests/run-local-inventory-lifecycle.ps1` comprueba los mismos archivos generados en PostgreSQL 17 descartable, incluido el rollback del ensayo. Regenerar y volver a probar si cambia el candidato.

## Reglas de resolución

- Se usa `catalog.sku_identity` para resolver producto/variante. No se inventan SKU, versiones ni eventos.
- La baja actual solo se inicializa con su `catalog.sku.deactivated` autoritativo. Si el padre se desactivó y Catalog no emitió evento SKU por variante, el candidato rechaza esa identidad.
- Reactivación después de una baja se rechaza: el código actual no publica un evento contractual de activación SKU que permita ordenar lifecycle con seguridad.
- Un SKU activo sin evento de baja se toma como baseline del estado actual de Catalog; `updated_at` no se declara como un evento emitido.
- Los borradores no vendibles sin versión positiva/stock quedan fuera. Una versión superior existente en Inventory se conserva.
- El cuerpo no escribe en stock, reservas, operaciones, kardex, outbox, conciliaciones offline, Catalog o ledgers. Tampoco emite eventos.

## Postcondiciones y reversión

Postcondiciones: cada elegible tiene la misma identidad de producto; su lifecycle corresponde a la versión candidata o a una versión previa más nueva que se conserva; la igualdad de versión coincide en estado y `changed_at`; los seis hashes de contenido protegido se mantienen; y el resultado termina con `POSTCHECK_OK`.

Antes del commit, un error o rechazo exige rollback completo. Después del commit, no hagas limpieza por prefijo: se requiere un manifiesto exacto de filas insertadas/avanzadas y sus valores previos. Solo revertir si cada fila todavía coincide exactamente con el resultado de esta ejecución y no hay eventos/cambios posteriores. No borrar tablas H5 ni alterar ledgers históricos. Grants runtime son una operación separada y no forman parte de estos SQL.

## Bloques de bootstrap HTTP (no async)

1. Ejecutar `05-release-bootstrap-preflight.sql` primero como consulta de solo lectura. Es un preflight focalizado y no reemplaza la revisión del ledger del microservicio.
2. Las tablas Inventory lifecycle/offline y Promotions H5 ya existen físicamente según la evidencia focalizada. No ejecutar CREATE/ALTER de esas estructuras. Catalog outbox trigger, Catalog delivery_transport y outboxes Inventory/Pricing se excluyen del bootstrap y quedan en Fase 6.
3. Grants Inventory solo después de confirmar que la ACA de release realmente usa `inventory_app`; el bloque versionado reutilizado está en `ops/azure/h5-runtime-preflight/inventory-runtime-grants.proposal.sql`:

```sql
GRANT USAGE ON SCHEMA inventory TO inventory_app;
GRANT SELECT, INSERT, UPDATE
  ON inventory.sku_lifecycle, inventory.offline_sale_reconciliations
  TO inventory_app;
```

4. Para Promotions, únicamente después de confirmar el principal/rol de release y aprobar el migration runner, ejecutar el candidato `apps/promotions-svc/migrations-candidate/h5/0002_coupon_http_runtime_role.sql` con transacción oficial y `SET LOCAL g6.promotions_h5_runtime_role = '<rol runtime confirmado>'`. El candidato concede solo SELECT/INSERT/UPDATE en las dos tablas H5; no ejecutar sobre el rol de desarrollo por comodidad. No añade DDL ni toca `coupon_uses`.
5. No hay bloque de reconciliación estructural para Inventory, Pricing o Promotions porque el handoff reporta equivalencia física. Su ledger pendiente no se “arregla” insertando versiones históricas; requiere migración nueva de verificación mediante el mecanismo oficial y revisión de DBA.
6. Catalog async candidate `catalog-h5-async-delta.candidate.sql` no se ejecuta en este rollout HTTP. Se reserva para Fase 6 con freeze de productores y una aprobación aparte.

**Postchecks de permisos** (ejecutar con lectura autorizada luego de un grant aprobado):

```sql
SELECT has_schema_privilege('inventory_app','inventory','USAGE') AS inventory_usage,
       has_table_privilege('inventory_app','inventory.sku_lifecycle','SELECT') AS lifecycle_select,
       has_table_privilege('inventory_app','inventory.sku_lifecycle','INSERT') AS lifecycle_insert,
       has_table_privilege('inventory_app','inventory.sku_lifecycle','UPDATE') AS lifecycle_update,
       has_table_privilege('inventory_app','inventory.offline_sale_reconciliations','SELECT') AS offline_select,
       has_table_privilege('inventory_app','inventory.offline_sale_reconciliations','INSERT') AS offline_insert,
       has_table_privilege('inventory_app','inventory.offline_sale_reconciliations','UPDATE') AS offline_update;

SELECT has_table_privilege('po_promotions_runtime','promotions.h5_coupon_operations','SELECT') AS operations_select,
       has_table_privilege('po_promotions_runtime','promotions.h5_coupon_operations','INSERT') AS operations_insert,
       has_table_privilege('po_promotions_runtime','promotions.h5_coupon_operations','UPDATE') AS operations_update,
       has_table_privilege('po_promotions_runtime','promotions.h5_coupon_outbox','SELECT') AS outbox_select,
       has_table_privilege('po_promotions_runtime','promotions.h5_coupon_outbox','INSERT') AS outbox_insert,
       has_table_privilege('po_promotions_runtime','promotions.h5_coupon_outbox','UPDATE') AS outbox_update;
```

Estos bloques son preparación/revisión; no se ejecutaron en Supabase compartido. No se ha identificado una diferencia estructural que justifique DDL en el bootstrap HTTP.
