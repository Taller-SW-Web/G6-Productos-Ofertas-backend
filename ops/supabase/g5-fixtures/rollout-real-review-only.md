# Rollout real de Inventory SKU lifecycle — revisión solamente

**No ejecutar en esta fase.** El coordinador reserva la ejecución real mediante el conector Supabase. Este procedimiento no autoriza DDL, ledger, grants ni escrituras de fixtures. `AZURE_CHILE_DEPLOY_ENABLED` no se relaciona con Supabase.

## Secuencia única reproducible

1. En la misma sesión del conector, confirmar el proyecto/ref `slzglmtiyrzygpkiuthf`, PostgreSQL 17, usuario operador, schemas/tablas, owners, columnas y constraints. Consultar solo lectura el ledger de `inventory` y mantener separado el ledger global. No insertar ni modificar ledgers.
2. Confirmar que las precondiciones del handoff directo continúan vigentes: identidades SKU inequívocas, versiones positivas dentro del rango `integer`, sin lifecycle preexistente inesperado, y sin cambios concurrentes. No repetir la auditoría general; si los resultados focalizados difieren de la evidencia aprobada, detener la operación.
3. Verificar lectura autorizada de `catalog.sku_identity`, `catalog.products`, `catalog.variants`, `catalog.outbox`, `inventory.stock_balance` y de las seis tablas protegidas. `catalog.outbox` es necesario para ligar una baja a la versión/timestamp autoritativos de `catalog.sku.deactivated`. La escritura queda limitada a `inventory.sku_lifecycle`.
4. Para ensayo, enviar **todo el contenido** de `inventory-sku-lifecycle-ensayo.transaction.sql` como una única solicitud SQL. Es SQL ordinario (sin `\i`, `\if`, variables psql ni dependencia de una segunda conexión); abre transacción, configura el opt-in con `SET LOCAL`, corre el cuerpo, postcondiciones y hashes de contenido y termina en `ROLLBACK`. Aceptar únicamente `POSTCHECK_OK` sin error. El rollback es obligatorio aun si las comprobaciones pasan.
5. Tras revisar el ensayo, obtener aprobación separada de rollout. Ejecutar **todo el contenido** de `inventory-sku-lifecycle-apply.transaction.sql` como una única solicitud SQL en una sola conexión. Ese bloque usa el mismo cuerpo/pre/post que el ensayo y termina en `COMMIT` únicamente después de aprobar todas las verificaciones.
6. Si falta una condición, cualquier identidad se rechaza, hay drift, una versión/evento no cuadra o el conector informa error, detenerse. La excepción aborta la transacción; solicitar `ROLLBACK` en esa sesión antes de cerrar. El resumen de rechazo se devuelve como `DETAIL` de la excepción `LIFECYCLE_BACKFILL_REJECTED`; no interpretarlo como éxito ni reintentar hasta resolver la causa mediante revisión.
7. Verificar la respuesta `POSTCHECK_OK`, el resumen `eligible/inserted/advanced/preserved` y los hashes iguales para stock, reservas, operaciones, kardex, outbox y conciliaciones offline. Adjuntar evidencia sanitizada.

Los dos archivos SQL son bloques completos ejecutables. Se generan desde `inventory-sku-lifecycle-backfill.candidate.sql` mediante:

```powershell
pwsh -NoProfile -File ops/supabase/g5-fixtures/generate-lifecycle-rollout.ps1
```

La prueba local verifica el candidato en PostgreSQL 17 descartable, incluidos el ensayo y el rollback. Cualquier cambio del candidato requiere regenerar ambos bloques y repetir las pruebas antes de una revisión real.

## Semántica y límites

- Todos los propietarios provienen de `catalog.sku_identity` y de la fila exacta de producto/variante. Los SKU base de productos con variantes siguen representados como no activos vendibles.
- Una baja actual requiere el evento autoritativo `catalog.sku.deactivated`; `sku_version` y `changed_at` salen de ese payload, no de un `updated_at` posterior. Una reactivación tras una baja se rechaza porque Catalog no publica actualmente un evento contractual de activación de SKU. Una desactivación de padre que solo produce `catalog.product.deactivated` no se convierte en eventos por variante.
- Una fila activa sin evento de baja es una instantánea de baseline tomada del propietario actual de Catalog, no una afirmación de que `updated_at` sea un evento de activación.
- Una identidad inválida, ambigua, sin versión requerida o incompatible aborta el lote completo. Las identidades de borrador no vendibles, sin stock y sin versión positiva quedan excluidas. Nunca se inventan versiones.
- El candidato no emite eventos y no modifica Catalog, stock, reservas, operaciones, kardex, outbox, conciliaciones ni ledgers.
- Los cambios a grants son un paso independiente, con revisión y autorización separadas; no están incluidos en estos bloques.

## Recuperación

Antes del commit, cualquier error debe terminar en rollback completo. Después del commit no hacer un `DELETE` por prefijo. La reversión requiere manifiesto exacto de filas insertadas/avanzadas por la ejecución y sus valores anteriores; eliminar/restaurar únicamente si las filas siguen coincidiendo con el resultado de esta ejecución y ninguna versión/evento posterior existe. Ante cualquier diferencia, detenerse. No revertir mensajes comerciales porque el backfill no publica eventos.
