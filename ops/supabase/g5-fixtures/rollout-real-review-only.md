# Secuencia SQL candidata para revisión de rollout real

**NO EJECUTAR.** Preparado para revisión posterior por ChatGPT/DBA mediante el conector autorizado. No es una autorización de escritura. Nunca ejecutar en una conexión cuya identidad de proyecto/database no haya sido verificada desde esa misma sesión. Marketplace y tablas comerciales reales quedan fuera del alcance.

## Orden y gates

1. Obtener aprobación explícita de rollout, confirmar ventana y cerrar otros escritores/consumidores que puedan cambiar Catalog SKU/lifecycle/stock. `AZURE_CHILE_DEPLOY_ENABLED` no interviene en Supabase.
2. Abrir transacción read-only y verificar el proyecto/ref autorizado, versión PostgreSQL 17, schemas/tablas, columnas, constraints, índices, trigger/owners y ledgers particulares. El conector debe revelar el identificador de proyecto, no una contraseña. Comparar checksums con `migrations-reconciliation.md` y comparar DDL completo contra los candidatos. Si cualquier estado difiere de lo esperado, parar; no reparar el ledger aquí.
3. Verificar que todo `inventory.stock_balance.sku_id` tenga exactamente una fila en `catalog.sku_identity`, parent único y versión compatible; previsualizar base/variante, entidades versionadas sin stock, sin lifecycle, mismatches, cambios concurrentes y conteos. Confirmar que el baseline de stock/reservas permanece igual antes y después.
4. Aplicar el backfill lifecycle solamente tras aprobación separada. Usar `inventory-sku-lifecycle-backfill.candidate.sql` en una misma sesión/transacción con opt-in `SET LOCAL g6.inventory_sku_lifecycle_backfill='apply'`. El candidato aborta si hay identidad ambigua/faltante, versión inválida, conflicto de versión/estado o stock huérfano; no inserta ni avanza parcialmente si encuentra rechazos.
5. Releer lifecycle y las invariantes protegidas. Verificar conteos y digest/captura de las filas agregadas/avanzadas, además de que stock, reservas, operaciones, kardex, offline reconciliation y outbox no hayan cambiado. La salida de resumen/rechazos debe ser adjunta y sanitizada.
6. Permisos Inventory: reutilizar `ops/azure/h5-runtime-preflight/inventory-runtime-grants.proposal.sql` únicamente cuando la identidad real de DB de la ACA esté identificada y aprobada como `inventory_app` o se haya revisado el nombre correcto. Comparar antes/después: USAGE schema, SELECT/INSERT/UPDATE solo en las dos tablas indicadas, sin DELETE/DDL ni otros esquemas.
7. Promotions: comparar DDL existente de `h5_coupon_operations` y `h5_coupon_outbox` contra candidata 0001; no volver a ejecutar CREATE sobre tablas ya presentes. Aplicar candidata 0002 solo después de confirmar rol de runtime exacto (`po_promotions_runtime` solo si la ACA realmente hereda de él) y pre/post privilegios. Mantener `coupon_uses.restored_at` column-scoped; no conceder DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN o DDL.
8. Reabrir transacción read-only para postcondiciones y ledger. No insertar entradas ficticias: si el DDL ya está desplegado sin registro de servicio, crear una migración de reconciliación versionada y aprobada mediante el mecanismo oficial, no falsificar historial.

## SQL de preflight y postcheck (solo lectura)

Ejecutar tras envolver cada bloque en transacción `READ ONLY` y `ROLLBACK`. Este bloque no certifica por sí solo DDL ni reemplaza el preflight del runbook:

```sql
BEGIN TRANSACTION READ ONLY;
SELECT current_setting('server_version_num')::int AS server_version_num,
       current_database() AS database_name,
       current_user AS effective_role;
SELECT count(*) AS identities,
       count(*) FILTER (WHERE product_id IS NULL) AS no_product_id,
       count(*) FILTER (WHERE variant_id IS NULL) AS no_variant_id
FROM catalog.sku_identity;
SELECT count(*) AS stock_rows,
       count(DISTINCT b.sku_id) AS distinct_stock_skus,
       count(*) FILTER (WHERE si.id IS NULL) AS unresolved_stock_rows,
       count(*) FILTER (WHERE l.sku_id IS NULL) AS stock_without_lifecycle
FROM inventory.stock_balance b
LEFT JOIN catalog.sku_identity si ON si.sku = b.sku_id
LEFT JOIN inventory.sku_lifecycle l ON l.sku_id = b.sku_id;
SELECT count(*) AS lifecycle_rows,
       count(*) FILTER (WHERE sku_version <= 0) AS invalid_versions
FROM inventory.sku_lifecycle;
ROLLBACK;
```

Verificar además el catálogo completo de columnas, `pg_get_constraintdef`, índices, triggers, owners, privilege tables y los ledgers `inventory.schema_migrations`/`promotions.schema_migrations` por separado. El `supabase_migrations.schema_migrations` global no es sustituto.

## Aplicación futura (no ejecutar en esta fase)

El backfill ya contiene `BEGIN`, gate y checks de consistencia. Secuencia del operador, una vez autorizada:

```text
1. Conectar a la base/branch aprobada y ejecutar/guardar preflight read-only.
2. Confirmar permiso de escritura solo del operador y la ventana autorizada.
3. En la misma conexión: SET LOCAL g6.inventory_sku_lifecycle_backfill = 'apply'; ejecutar inventory-sku-lifecycle-backfill.candidate.sql.
4. Si resumen REJECTED_NO_WRITES o cualquier error: ROLLBACK/abortar y escalar; no repetir ni reparar manualmente.
5. Si resumen APPLIED y postchecks íntegros: COMMIT bajo aprobación del responsable de datos.
6. Aplicar grants mínimos solo en una transacción separada tras identidad/runtime role verificados.
```

No se publica una carga de fixtures shared. Las filas sintéticas de prueba solo se cargan en PostgreSQL local descartable, a través de sus triggers de Catalog.

## Reversión

- Antes de COMMIT, cualquier error o rechazo implica `ROLLBACK` de la transacción completa.
- Después de COMMIT, no hacer un DELETE masivo por prefijo. La reversión lifecycle requiere manifiesto exacto, capturado antes del paso, de las filas lifecycle inexistentes previamente y de cualquier fila avanzada con valor original. Revertir únicamente filas que todavía coincidan exactamente con el resultado introducido por esta ejecución y solo con ventana de escritura coordinada. Si hay eventos posteriores, nuevos stock rows o versión lifecycle más alta, detenerse y conservar el estado; no sobrescribir un valor posterior.
- Los grants se revierten solo revocando permisos exactos añadidos por este rollout, después de verificar que no los necesita otra ejecución. No revocar membresías preexistentes ni permisos de development.
- Las tablas Promotions H5 ya existentes nunca se dropean como rollback. No se borra ni se reescribe ningún ledger histórico.
- No existe reversión automática de eventos o efectos comerciales porque el backfill no los emite. No se debe publicar evento sintético para “compensar”.

## Requisitos de aprobación futura

Debe adjuntarse evidencia de identidad de proyecto, checksums, DDL equivalence, resumen de filas sin identificadores comerciales, principal ACA→rol PostgreSQL, ventana, conteos pre/post e invariantes. Marketplace sigue protegido; retest funcional `NOT_VERIFIED`. La ejecución no debe inferir consentimiento de una ventana finalizada ni de la existencia de tablas.
