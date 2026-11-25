# G5/H5 fixtures — PostgreSQL aislado

Este paquete contiene pruebas locales reproducibles y candidatos de SQL. No se conecta a Supabase compartido y no autoriza despliegue, grants, ejecución de escenarios comerciales reales ni activación de Service Bus.

## Frontera de aislamiento

`tests/run-local-h04-bootstrap.mjs` is the shared H04 database bootstrap. It
starts a uniquely labeled PostgreSQL 17.11 container, binds its ephemeral port
to loopback only, applies the versioned Catalog, Inventory, Pricing, and
Promotions test DDL, and checks a single synthetic identity across all four
schemas. Each service uses a separate non-superuser runtime principal. The
runner checks each intended read, rejects cross-schema access, and removes only
the container carrying its matching ownership label, including on failure.
The container uses host SCRAM-SHA-256 authentication. It generates ephemeral
random passwords for the bootstrap and runtime logins; they are passed only to
the local process/container and are never emitted. Promotions receives only the
table grants defined by its versioned migrations: the two H5 tables allow
SELECT/INSERT/UPDATE, while DELETE/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN and
schema CREATE are denied. A future-table probe ensures no broad default grant
leaks to other Promotions tables. The `asRole` helper verifies the effective
identity and restoration; a negative failure probe proves the next operation
does not inherit the temporary role.
G5/G7, shared Supabase, Azure, and Service Bus are not contacted. This first
increment proves common-schema bootstrap and isolation; it does not claim the
four-service commercial flow or complete H04.

Run from the repository root with the supported Node/npm engines installed:

```powershell
node ops/supabase/g5-fixtures/tests/run-local-h04-bootstrap.mjs
```

CI runs the same command in the existing Inventory disposable-PostgreSQL job.
The cleanup failure path can also be verified locally with
`$env:G6_H04_INJECT_FAILURE='after-seed'` before running the command: it must
exit nonzero and still print `DISPOSABLE_POSTGRES_CLEANUP_CONFIRMED`.

The bootstrap seeds Catalog and Inventory from the existing deterministic
fixture, adds matching Pricing validity and Promotions coupon rows, and checks
the generated Inventory availability value. These inserts initialize the test
database only; no business operation is modeled by direct SQL.

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

`ops/azure/h5-runtime-preflight/inventory-sku-lifecycle-backfill.candidate.sql` resuelve las identidades mediante `catalog.sku_identity` y su dueño exacto (producto base o variante). El candidato es un cuerpo SQL reutilizable; no inicia ni termina la transacción. Los bloques completos para el conector se generan en `inventory-sku-lifecycle-apply.transaction.sql` y `inventory-sku-lifecycle-ensayo.transaction.sql`; el primero conserva `BEGIN`/`SET LOCAL`/precheck/postcheck/`COMMIT`, y el ensayo termina siempre en `ROLLBACK`. Cualquier rechazo eleva excepción con resumen y aborta el lote; no existe un estado de éxito `REJECTED_NO_WRITES`.

Para un SKU inactivo por transición de lifecycle, versión y `changed_at` provienen del último evento autoritativo `catalog.sku.deactivated`. Un `updated_at` posterior por otro cambio no reemplaza ese evento. Si Catalog muestra reactivación después de una baja, o la desactivación del padre de variantes no produjo evento SKU para una identidad que ahora no es vendible, el candidato rechaza esa identidad porque la secuencia no es inequívoca. Una identidad activa sin evento previo de baja se inicializa como snapshot del Catalog actual; `updated_at` no se presenta como evento emitido. El SKU base de un producto con variantes sigue no vendible. Borradores sin versión positiva ni stock se excluyen.

La verificación requiere SELECT de Catalog identities/products/variants/outbox y de las tablas Inventory protegidas para comparar hashes; la única escritura del candidato es `inventory.sku_lifecycle`. No altera stock, reservas, operaciones, kardex, outbox, conciliaciones offline, Catalog ni ledgers.

La población requerida se toma del contrato operativo `sku_lifecycle` como catálogo versionado completo, no como mero conjunto de SKU con stock. El test demuestra SKU base simple, SKU base de producto con variantes (inactivo), variante activa, borrador versión cero excluido, versión superior preservada, conflicto de identidad/estado, overflow, falta de identidad y conservación del stock. La elegibilidad real se debe volver a previsualizar desde el dataset al momento de rollout.

## Promotions: semántica del canal

En la evidencia de pedido G5, `channel_id` es el canal comercial original y acepta `MARKETPLACE`, `CHATBOT` o `RETAIL`. El remitente/identidad técnica sigue siendo `modulo-ventas`. `VENTAS` permanece válido donde las tablas/configuración históricas lo definen, como `promotions.enabled_channels` y `price_projection`; no se amplía al snapshot ni a `coupon_uses`. Las pruebas focalizadas ejercitan los tres canales válidos, rechazan `VENTAS` en snapshot/comando y preservan la identidad del remitente. No se requirió cambio productivo de Promotions.

## Supabase compartido y ledgers

Las lecturas directas base son el handoff sanitizado `HANDOFF-SUPABASE-G6-H5-AUDITORIA-DIRECTA.md` suministrado por coordinación y las comprobaciones focalizadas de checksums descritas en `migrations-reconciliation.md`. En esta rama no se ejecuta DDL/DML/GRANT ni se altera ledger. La presencia de una tabla u objeto no se convierte en un registro ficticio de migración.

La secuencia de revisión está en `ROLLOUT-CHATGPT-SUPABASE.md` y `rollout-real-review-only.md`. Los dos bloques SQL completos son aptos para una solicitud única del conector; no dependen de `\\i`/`\\if`. El ensayo siempre hace rollback. No ejecutar en Supabase compartido sin autorización futura. Las tablas H5 existentes no se recrean.

## Supuestos y límites

- Los roles de prueba verifican los permisos SQL mínimos, no certifican automáticamente la identidad de la ACA.
- Los endpoints G5/G7 son simulados por contrato; no hay credenciales externas en las pruebas.
- La prueba H5 Promotions cubre admisión, outbox, worker, resultado, idempotencia, restauración, autorización SQL y recuperación simulada; no prueba red real, Service Bus real ni homologación G5/G7.
- No se considera que un prefijo QA aísle producción. Sin RLS que aísle filas, fixtures reales requieren branch/base aprobada y credenciales dedicadas con revisión completa.
- Escenarios que comparten pedido, stock, reserva, cupón, expiración o identidad de mensaje son seriales/exclusivos. Solo lecturas sin mutación o fixtures con todas las claves/stock independientes se pueden paralelizar localmente.
- Marketplace retest funcional permanece `NOT_VERIFIED`; sus objetos e imágenes no fueron tocados.

## Evidencia focalizada DDL del conector

No ejecutar `CREATE TABLE` para Inventory lifecycle/offline reconciliation/outbox_delivery, Pricing outbox, ni Promotions coupon operations/outbox: el handoff DDL directo confirmó equivalencia estructural. Su ledger, ACL y readiness continúan separados. Catalog ya tiene la tabla `outbox_delivery`; su delta canónico de función/trigger y `delivery_transport` está en `catalog-h5-async-delta.candidate.sql`, es solo Fase 6 y su prueba local confirma que no genera deliveries para outbox histórico. No aplicar ese delta para arrancar HTTP.

El recorrido local de los cuatro servicios continúa `PARTIAL`: los runners de servicio usan sus propias bases desechables. No representan una sola fixture cross-service ni homologación G5/G7.
