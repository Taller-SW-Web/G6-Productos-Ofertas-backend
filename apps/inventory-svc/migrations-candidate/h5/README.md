# Persistencia candidata H5 — Inventory Service Bus Basic

`0001_outbox_delivery.sql` define la tabla `inventory.outbox_delivery` para soportar la entrega punto a punto hacia Azure Service Bus Basic (sin tópicos ni suscripciones).

`0002_allow_bulk_r10_delivery.sql` es una migración incremental **aplicada y verificada en Supabase compartido el 27/11/2026** para admitir el destino contractual R10 `g6.bulk.from.inventory` dentro de `ck_inventory_delivery_route`, preservando los tres destinos previos (R11, R12 y R13), la tabla, la clave primaria, los índices y los permisos de `inventory_app`. Incluye guard de propietario (`po_inventory_owner`), `lock_timeout`/`statement_timeout` acotados y validación (`NOT VALID` + `VALIDATE CONSTRAINT`) antes del intercambio. Su rollback (`0002_allow_bulk_r10_delivery.rollback.sql`) aborta explícitamente si ya existen entregas Bulk (`g6.bulk.from.inventory`) para impedir pérdida silenciosa de ruta.

## Estado real por capa (separación obligatoria)

| Capa | Estado real en el candidato (`#307`) | Detalle verificable |
|---|---|---|
| **Código runtime (`inventory-svc` + `bulk-svc`)** | **IMPLEMENTADO** | `inventory-svc` implementa el receptor/handler R02 (`processBulkStockAdjust` con rollback íntegro ante fallo técnico, Inbox idempotente, ajuste de saldo y registro de entrega R10) y el relay/productor R10 hacia `g6.bulk.from.inventory`. `bulk-svc` implementa el consumidor R10 y la conciliación del estado terminal del lote. |
| **Esquema compartido (Supabase)** | **APLICADO Y VERIFICADO** | El historial global registra `20261127200858` y el ledger de Inventory registra `0002_allow_bulk_r10_delivery.sql` con su checksum. El readback verificó la restricción validada con los cuatro destinos, cero filas y los permisos de `inventory_app`. |
| **Flags operativos (ACA)** | **DESACTIVADOS por defecto (`OFF`)** | Aplicar `0002_allow_bulk_r10_delivery.sql` no habilita automáticamente R02/R10; el tráfico requiere activar los flags `SEND`/`RECEIVE` correspondientes tras el despliegue autorizado del candidato. |
| **Despliegue ACA (`rg-g6-aca-chile`)** | **NO DESPLEGADO** | `inventory-svc` y `bulk-svc` en Azure aún corren revisiones previas al candidato `#307`. |
| **Evidencia L1 (aislado PG17 descartable)** | **PASS** | `apps/inventory-svc/test/inventory-h5.postgres.e2e-spec.ts` (26/26), `0002` aplicada ×2 + 4 destinos con rol `inventory_app` + 3 negativos + rollback condicionado (aborta con fila Bulk y revierte tras limpieza descartable), `tests/h5/certify-158-endpoints.mjs` (#106/#109 `COMPLETED`) y `tests/h5/certify-19-messaging-flows.mjs` (R02/R10 `PASS`, `HTTP_IN_MEMORY_NOT_AZURE`). |
| **Evidencia L2 (Azure real)** | **PENDIENTE** | Requiere despliegue de imágenes OCI del candidato y corrida sintética autorizada sobre `g6-sb-h5-chile-261127`. |

## Características técnicas

1. **No destructiva**: No altera migraciones H4 ni `0001_outbox_delivery.sql`, no realiza backfills y nunca se ejecuta en el bootstrap de la aplicación.
2. **Destinos contractuales aprobados (G6 Service Bus Basic)**:
   - **R10**: `g6.bulk.from.inventory` (`inventory.bulk.stock.adjust.completed`, `inventory.bulk.stock.adjust.rejected`) — agregado por `0002_allow_bulk_r10_delivery.sql` (código implementado y esquema compartido verificado).
   - **R11**: `g6.catalog.from.inventory` (`inventory.sku.initialization.completed`, `inventory.sku.initialization.rejected`).
   - **R12**: `g6.combos.from.inventory` (`inventory.stock.changed`).
   - **R13**: `g6.promotions.from.inventory` (`inventory.stock.changed`).
3. **Clave primaria compuesta**: `(message_id, destination)` asegura entrega idempotente independiente por consumidor.
4. **Lease y reintentos**: Soporta bloqueo distribuido transaccional (`FOR UPDATE SKIP LOCKED`) con token de lease y backoff exponencial acotado a 60 segundos. Mensajes que excedan el límite de 256 KB registran un fallo terminal recuperable sin reintentos infinitos.
5. **Permisos mínimos**: El esquema y la tabla pertenecen a `po_inventory_owner`; únicamente `inventory_app` recibe `SELECT`, `INSERT` y `UPDATE` (sin privilegios DDL ni `DELETE`).
