# G6-H5-F — H04 local y preparación Bootstrap HTTP

Fecha: 2026-11-24 (America/Lima)
Rama: `trabajo/castilla/h5-integracion-cuatro-servicios`
Base de inicio: `d1f4af9401a142c8c1217e5eb9591fe5e4696c4e`
Master sincronizado sin reescritura: `b601f57c4ba00c45fe46061023b548bf49d6df16`

## Estado de H04

Se implementó y ejecutó el **Incremento 1: bootstrap común aislado**. H04 completo continúa pendiente. El runner no reemplaza operaciones comerciales por SQL y declara expresamente que no ejecutó el flujo de compra.

`ops/supabase/g5-fixtures/tests/run-local-h04-bootstrap.mjs` crea un contenedor `postgres:17.11` con etiqueta de propiedad aleatoria y puerto efímero ligado solamente a `127.0.0.1`. Carga las fixtures/migraciones locales de Catalog e Inventory, la fixture PostgreSQL de Pricing que ya usa su prueba, las migraciones oficiales Promotions fijadas y verificadas por SHA y los dos candidatos locales HTTP H5 de Promotions. No acepta un URL externo ni contiene una ruta a Supabase.

El seed usa producto, variante, SKU, lifecycle, ubicación, ruta comercial, stock, definición y vigencia Pricing, promoción y cupón sintéticos coherentes. El seed de Pricing inserta definición y vigencia en una misma transacción para respetar el trigger de timeline. No desactiva constraints ni triggers y no inserta en `stock_balance.available`, columna generada.

Se crean owners separados y logins runtime separados (`catalog_app`, `inventory_app`, `pricing_app`, `promotions_app`). El harness valida una lectura autorizada por servicio, cuatro rechazos de lectura entre schemas y flags administrativos desactivados. El dueño de base solo se usa para cargar DDL/seed y ejecutar aserciones; las lecturas de runtime se ejecutan como sus logins no superusuario.

El `finally` verifica la etiqueta antes de borrar únicamente su contenedor y confirma que no queda. No se publica puerto fuera de loopback, no se usan datos Marketplace, y no se contactan ACA, Supabase compartido, G5, G7 ni Service Bus.

### Ejecución reproducible

Requisitos: Docker con `postgres:17.11`, Node `v24.15.0` o superior permitido por `package.json`, npm `>=10` y dependencias instaladas con el lockfile.

```powershell
node --version
npm --version
npm ci
node ops/supabase/g5-fixtures/tests/run-local-h04-bootstrap.mjs
```

Resultado de esta intervención:

```text
result: PASS
increment: 1
schemas: catalog, inventory, pricing, promotions
allowedReads: 4
crossSchemaDenials: 4
runtimeAdminFlags: false
sharedSupabaseUsed: false
marketplaceDataCopied: false
commercialOperationsExercised: false
DISPOSABLE_POSTGRES_CLEANUP_CONFIRMED
```

La imagen `postgres:17.11` ya estaba disponible. Se verificó `node v24.15.0`, `npm 11.4.2`; el `npm` instalado globalmente invocaba el Node 24.3.0, por lo que las instalaciones/ejecuciones se hicieron explícitamente mediante el ejecutable npm CLI del sistema bajo el `node.exe` portable 24.15.0. No se alteró `package.json` ni la instalación global.

## Pruebas enfocadas

| Comando                                                                                                                                                                                                  | Estado                     | Resultado y límite                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node ops/supabase/g5-fixtures/tests/run-local-h04-bootstrap.mjs`                                                                                                                                        | PASS                       | PostgreSQL 17.11 común, cuatro schemas/roles, fixture coherente, ACL y cleanup. Incremento 1, no recorrido H04.                                                                                                                                                                       |
| `pwsh -NoProfile -File ops/supabase/g5-fixtures/tests/run-local-inventory-lifecycle.ps1`                                                                                                                 | PASS                       | Ensayo/apply local, atomicidad, hashes de tablas protegidas, rechazo de lote mixto y grants runtime; cleanup confirmado.                                                                                                                                                              |
| `node apps/promotions-svc/test/run-h5-postgres.mjs`                                                                                                                                                      | PASS                       | 12/12 pruebas H5 Promotions sobre PostgreSQL local y rol runtime; cleanup confirmado.                                                                                                                                                                                                 |
| `npm run build:pricing-svc`                                                                                                                                                                              | PASS                       | Build enfocado requerido por el test histórico.                                                                                                                                                                                                                                       |
| Test `apps/pricing-svc/test/catalog-pricing.integration.e2e-spec.ts` con `CATALOG_PRICING_WORKTREE` en el worktree detached exacto `263bd2655184c3cd559ab1f682a75f3730f5f85f` y `PRICING_TEST_CATALOG=1` | FAIL_RUNTIME_TEST, aislado | La prueba heredada inició su fixture y falló esperando el consumidor Pricing en `po.precios.q` (`Timeout esperando consumidor Pricing en po.precios.q`). Es una regresión Catalog/Pricing/H4 con RabbitMQ; no es prueba H04. No se modificó el SHA de su precondición ni la rama H04. |

La primera invocación histórica se detuvo por falta de `dist/apps/pricing-svc/main.js`; tras compilar Pricing se ejecutó el caso funcional. La salida final del runner fallido confirma cleanup del test H04 común; se verificó adicionalmente que el contenedor `pricing-catalog-*` de la regresión ya no estaba presente.

## Límite de aceptación

Quedan NOT_RUN los Incrementos 2–4: lecturas comerciales a través de las fronteras oficiales, reserva + consumo + consulta + confirmación/replay, y cancelación + restauración/replay. El harness actual no arranca Catalog, Inventory, Pricing ni Promotions como servicios HTTP y no ejecuta sus handlers/repositories para esos actos. Por tanto:

- `H04_LOCAL_BOOTSTRAP` = PASS.
- `H04_LOCAL_INTEGRATED` = PARTIAL; no declarar H04 completo.
- `G5_G7_LOCAL_CONTRACT_DOUBLES` = NOT_RUN por esta prueba; las suites existentes de Promotions usan evidencia local aislada y no constituyen recorrido interservicios.
- `G5_G7_REAL_HOMOLOGATION` = NOT_RUN.
- `SERVICE_BUS_REAL` = NOT_RUN.

Siguiente tarea concreta: añadir al runner servicios separados comunicados por HTTP conforme a OpenAPI, con el mismo PostgreSQL y logins, implementando primero las lecturas de Catalog/Pricing/Inventory/Promotions. Incorporar luego los escenarios de reserva/confirmación y cancelación/restauración. Solo se permite simular G5/G7 en la frontera externa. No mezclar la regresión histórica H4 ni inferir integración de cuatro servicios por compartir el seed.

## Bootstrap HTTP Chile — actualización desde evidencia previa

No se volvió a consultar Azure ni Supabase. La matriz siguiente reutiliza el preflight `HANDOFF-G6-H5-F-BOOTSTRAP-HTTP-CHILE.md` del worktree `h5-fixtures-integracion-g5` y se limita a la preparación de la secuencia:

| Servicio   | ACA runtime DB login                                   | Delta runtime conocido por evidencia Supabase                                                                                                                                                                                                                            | Estado para bootstrap HTTP                                                                             |
| ---------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Gateway    | NOT_VERIFIED desde secretos ACA                        | No requiere login DB propio según el preflight; depende de APIs internas                                                                                                                                                                                                 | Mantener endpoints/identidad upstream; smoke de ruta protegida acreditado en preflight.                |
| Catalog    | NOT_VERIFIED desde configuración ACA                   | No se reportó delta de grants HTTP en el preflight                                                                                                                                                                                                                       | Mantener el login/roles aprobados del servicio; no inferir identidad a partir de referencias secretas. |
| Inventory  | NOT_VERIFIED (`PGUSER` es secret reference no legible) | Rol previsto `inventory_app` → `po_inventory_runtime`; `USAGE inventory`; `SELECT,INSERT,UPDATE inventory.sku_lifecycle`; `SELECT,INSERT,UPDATE inventory.offline_sale_reconciliations`; la ruta/lifecycle requiere sus lecturas existentes verificadas por la propuesta | Reconfirmar el login por un mecanismo que solo exponga el username antes de cualquier GRANT real.      |
| Pricing    | NOT_VERIFIED desde configuración ACA                   | No se reportó delta de grants HTTP del candidate en el preflight                                                                                                                                                                                                         | Revalidar candidato de imagen, migraciones y credenciales antes de release.                            |
| Promotions | NOT_VERIFIED (`PGUSER` es secret reference no legible) | `po_promotions_runtime`: `SELECT,INSERT,UPDATE` en `h5_coupon_operations` y `h5_coupon_outbox`; sin DELETE/TRUNCATE/DDL                                                                                                                                                  | Reconfirmar login real y revisar smoke protegido pendiente antes de release.                           |

Secuencia aún pendiente: gate Chile cerrado; verificar master/CI y un candidato compatible; ensayo de backfill lifecycle; revisar manifiesto y postchecks; autorizar y aplicar backfill en ventana sin escritores; confirmar logins; aplicar solo grants mínimos revisados; postcheck con cada login; construir/publicar digest por SHA; aprobación Environment y CD oficial únicamente tras autorización explícita. No se ejecutó ningún paso real.

## Estado operativo y restricciones

`AZURE_CHILE_DEPLOY_ENABLED=false`. En esta intervención no hubo escritura en Azure, Supabase, ACA, Marketplace o Service Bus; tampoco hubo CD, deploy, publicación de imagen, HTTP al runtime ni prueba comercial externa.

| Estado                      | Resultado                                                                                                               |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `CHILE_DEPLOY_FREEZE`       | PASS, conservado según evidencia previa; no modificado.                                                                 |
| `ACA_RUNTIME_IDENTITIES`    | NOT_VERIFIED para los usernames de Inventory/Promotions; refs secretas no exponen valor.                                |
| `SUPABASE_ROLLOUT_PREPARED` | PASS como procedimiento anterior; no aplicado.                                                                          |
| `H04_LOCAL_BOOTSTRAP`       | PASS, este nuevo runner.                                                                                                |
| `H04_LOCAL_INTEGRATED`      | PARTIAL, falta recorrer operaciones reales de los cuatro servicios.                                                     |
| `G5_G7_REAL_HOMOLOGATION`   | NOT_RUN.                                                                                                                |
| `SERVICE_BUS_REAL`          | NOT_RUN.                                                                                                                |
| `HTTP_CD_REAL`              | NOT_RUN.                                                                                                                |
| `Draft PR`                  | Se prepara un PR Draft focalizado para el incremento 1 validado; no implica H04 completo ni habilitación de despliegue. |
