# G5/H5 fixtures — PostgreSQL aislado

Este paquete contiene pruebas locales reproducibles y candidatos de SQL. No se conecta a Supabase compartido y no autoriza despliegue, grants, ejecución de escenarios comerciales reales ni activación de Service Bus.

## Frontera de aislamiento

`tests/run-local-inventory-lifecycle.ps1` crea una instancia desechable `postgres:17.11` con nombre y etiqueta únicos, sin publicar un puerto. Su `finally` verifica la etiqueta de propiedad antes de eliminarla y confirma que desapareció. No usa `docker prune` ni toca otros contenedores. El helper crea únicamente la base local `h5_fixtures` dentro de ese contenedor.

La prueba carga DDL de las fixtures oficiales de Catalog e Inventory y la migración local de lifecycle. Los productos, variantes, SKU y ubicación son sintéticos y deterministas, no comparten prefijos/IDs con las fixtures Marketplace conocidas. Los triggers e invariantes de Catalog se mantienen activos; `stock_balance.available` se deja generar y `reserved + blocked <= on_hand`.

Para ejecutar:

```powershell
pwsh -NoProfile -File ops/supabase/g5-fixtures/tests/run-local-inventory-lifecycle.ps1
```

El test crea roles locales equivalentes y prueba escrituras de lifecycle con `inventory_backfill_test`; prueba los grants runtime por la conexión `inventory_app`, un login no superusuario. El proposal reutilizado está en `ops/azure/h5-runtime-preflight/inventory-runtime-grants.proposal.sql`. El rol operativo real referenciado por ACA no se identifica divulgando ni leyendo secretos; confirme el principal de DB fuera de logs antes de cualquier grant compartido.

La prueba de promociones se ejecuta mediante:

```powershell
node apps/promotions-svc/test/run-h5-postgres.mjs
```

Usa PostgreSQL local, migraciones candidatas de Promotions y conexiones separadas: setup local privilegiado y login `promotions_h5_runtime_test` para operaciones. G5 y el transporte/settlement Service Bus son doubles de contrato. No es homologación bilateral ni conexión real al namespace.

Las pruebas funcionales de Inventory existentes pueden ejecutarse con `INVENTORY_REAL_INTEGRATION=1` junto con `G6_DOCS_ROOT` apuntando al checkout local de Docs. Son integración local de la implementación y no autorizan mensajes reales; RabbitMQ, si lo usa el harness histórico, es únicamente para regresión H4 local.

## Lifecycle de Inventory

`ops/azure/h5-runtime-preflight/inventory-sku-lifecycle-backfill.candidate.sql` resuelve todos los SKU versionados mediante `catalog.sku_identity` y su dueño exacto (producto base o variante). Solo se consideran entidades con versión de Catalog positiva y representable por `integer`; estado, versión y timestamp proceden del dueño Catalog. Las versiones se comparan contra el estado actual de Inventory; un valor superior se conserva, una igualdad con datos distintos o identidad no resoluble rechaza el lote entero sin escrituras. El script requiere opt-in transaccional explícito, es idempotente y escribe solo `inventory.sku_lifecycle`, sin eventos ni cambios de stock, reservas, operaciones, kardex u outbox.

La población requerida se toma del contrato operativo `sku_lifecycle` como catálogo versionado completo, no como mero conjunto de SKU con stock. El test demuestra SKU base simple, SKU base de producto con variantes (inactivo), variante activa, borrador versión cero excluido, versión superior preservada, conflicto de identidad/estado, overflow, falta de identidad y conservación del stock. La elegibilidad real se debe volver a previsualizar desde el dataset al momento de rollout.

## Promotions: semántica del canal

En la evidencia de pedido G5, `channel_id` es el canal comercial original y acepta `MARKETPLACE`, `CHATBOT` o `RETAIL`. El remitente/identidad técnica sigue siendo `modulo-ventas`. `VENTAS` permanece válido donde las tablas/configuración históricas lo definen, como `promotions.enabled_channels` y `price_projection`; no se amplía al snapshot ni a `coupon_uses`. Las pruebas focalizadas ejercitan los tres canales válidos, rechazan `VENTAS` en snapshot/comando y preservan la identidad del remitente. No se requirió cambio productivo de Promotions.

## Supabase compartido y ledgers

Las lecturas directas base son el handoff sanitizado `HANDOFF-SUPABASE-G6-H5-AUDITORIA-DIRECTA.md` suministrado por coordinación y las comprobaciones focalizadas de checksums descritas en `migrations-reconciliation.md`. En esta rama no se ejecuta DDL/DML/GRANT ni se altera ledger. La presencia de una tabla u objeto no se convierte en un registro ficticio de migración.

La secuencia real propuesta para posterior revisión está en `rollout-real-review-only.md`; no es un script listo para ejecución. Precondiciones y postcondiciones deben pasar primero en el ambiente aprobado, y cualquier drift bloquea el paso. Las tablas H5 existentes no se recrean.

## Supuestos y límites

- Los roles de prueba verifican los permisos SQL mínimos, no certifican automáticamente la identidad de la ACA.
- Los endpoints G5/G7 son simulados por contrato; no hay credenciales externas en las pruebas.
- La prueba H5 Promotions cubre admisión, outbox, worker, resultado, idempotencia, restauración, autorización SQL y recuperación simulada; no prueba red real, Service Bus real ni homologación G5/G7.
- No se considera que un prefijo QA aísle producción. Sin RLS que aísle filas, fixtures reales requieren branch/base aprobada y credenciales dedicadas con revisión completa.
- Escenarios que comparten pedido, stock, reserva, cupón, expiración o identidad de mensaje son seriales/exclusivos. Solo lecturas sin mutación o fixtures con todas las claves/stock independientes se pueden paralelizar localmente.
- Marketplace retest funcional permanece `NOT_VERIFIED`; sus objetos e imágenes no fueron tocados.
