# Evidencia verificable — INFRA-001

Fecha: 2026-10-13 (America/Lima). Responsable: Axel Cueva. Rama: `cueva`.
Issue: [backend #1](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/1).

## Implementación local

Ejecutor Node sin dependencias nuevas: selección explícita de schema/entorno, allowlist de tablas/columnas, SQL generado desde datos, rechazo de destinos no registrados y demos en producción, login/grupo de carga dedicado, SSL verify-full, una transacción, repetición idempotente, assertions de contenido y constraints, advisory lock, timeouts, salida sin credenciales y checksum por archivo. Shared solo permite rollback.

Se entregan directorios required/demo para ocho contextos, un fixture reversible de Promociones, registry y manifiesto de identidades compartidas pendiente de revisión de owners. No se agregan APIs ni migraciones históricas de negocio; no se modifica ninguna otra aplicación.

| Comando | Resultado real |
| --- | --- |
| `node --test scripts/seed/run.test.mjs` | PASS, 8 tests / 0 fallos. |
| `node --check scripts/seed/run.mjs` | PASS. |
| `node scripts/seed/run.mjs --schema promotions --environment shared --kind demo --render-sql` | PASS, genera dos INSERT idempotentes y termina en ROLLBACK. No es prueba ejecutada en DB. |
| `git diff --cached --check` | PASS sobre los 28 archivos del cambio; diff revisado sin archivos fuera del issue. |
| `node_modules/.bin/oxlint scripts/seed` | PASS, código del ejecutor y tests. |
| `git merge --ff-only master` | PASS, autorizado expresamente; cueva avanzó a c875fda. |
| `npm ci` | PASS, 343 paquetes instalados desde el lockfile existente. |
| `npm test` | PASS, 9 archivos / 9 tests. |
| `npm run test:e2e` | PASS, 9 archivos / 9 tests. |
| `npm run typecheck` | PASS. |
| `npm run lint` | PASS. |
| `npm run build:all` | PASS. |
| `npm audit --json` | FAIL, 5 dependencias preexistentes con avisos: 2 low, 1 moderate, 2 high. No se cambiaron dependencias. |

La rama cueva inicialmente estaba en 42b5143 sin Foundation: los primeros comandos npm fallaron ENOENT. Tras autorización humana se ejecutó únicamente `git merge --ff-only master`, sin rebase ni force push. La primera ejecución sandbox de unitarias/E2E falló EPERM al renombrar temporales de Vitest; ambas se ejecutaron fuera de esa restricción y pasaron. No se modificó código ni configuración del monorepo para ocultar los errores. Los checks obligatorios del proyecto pasan.

## Auditoría real en Supabase

Consultas de lectura ejecutadas con el conector Supabase sobre proyecto existente `slzglmtiyrzygpkiuthf` (`Modulo de Productos y Ofertas`), región sa-east-1, PostgreSQL 17.11. Reproducción: `access/audit.sql`. El éxito del MCP demuestra acceso de auditoría del conector; no prueba el login psql individual de cada owner ni validación TLS de ese cliente.

| Schema | Owner comprobado | Tablas |
| --- | --- | ---: |
| taxonomy | po_taxonomy_owner | 13 |
| catalog | po_catalog_owner | 14 |
| pricing | po_pricing_owner | 8 |
| price_audit | po_price_audit_owner | 5 |
| promotions | po_promotions_owner | 14 |
| combos | po_combos_owner | 6 |
| inventory | po_inventory_owner | 16 |
| bulk | po_bulk_owner | 8 |

Total: **84 tablas**, todas con owner del schema correspondiente. **0 FK entre schemas**, **0 grants de schema a PUBLIC** y sin USAGE/CREATE efectivo de anon/authenticated en esos ocho schemas. Los owners tienen USAGE/CREATE únicamente en su schema; runtimes revisados tienen USAGE solo en su contexto y sin CREATE. PostgreSQL administrativo conserva acceso propio del conector. Se inspeccionaron ACL de todas las tablas y membresías de los roles propios; no se ejecutaron escrituras en contextos ajenos.

Baseline de Promociones antes de cualquier escritura:

```text
stock_projection_rows = 0
fixture_rows = 0
stock_projection_data_hash = d41d8cd98f00b204e9800998ecf8427e
table_structure_hash (84 tablas, columnas/tipos/nullability) = 8ffd8c47617a179f9f832757a0d2d1e5
```

Esta huella es una comparación estructural acotada (columnas/tipos/nullability), no un checksum exhaustivo de todas las funciones/constraints. El SQL de provisión no incluye ALTER de schemas/tablas/owners. No debe presentarse el baseline como un postcheck de una carga no ejecutada.

Antes del provisionamiento, `list_migrations` devolvió `[]`; **no significa ausencia de migraciones de negocio**. El repositorio oficial utiliza `<schema>.schema_migrations`; no se reejecutó ni copió su historial al mecanismo de seeds. Los modelos/migraciones normativos se consultaron en remoto, incluidos Promociones 0001–0004 y el despliegue documentado de Inventario 0002. Las dos entradas MCP nuevas corresponden exclusivamente a roles/grants de INFRA-001, no a versiones del ledger de negocio.

Se revisaron changelog/docs actuales de Supabase. El cambio TLS de HTTP anunciado el 12/10 no afecta conexiones PostgreSQL directas/pooler. La alerta de PostgreSQL 17.11 se revisó; este mecanismo no crea operadores ni usa cifrados legacy, ltree o índices nuevos. No se declara aquí que toda la base esté libre de esas alertas.

## Aplicación y prueba controlada

El primer intento de provisionamiento fue rechazado por revisión automática por requerir autorización del alcance exacto. Tras aprobación humana se aplicó `infra_001_seed_access_roles` versión `20261013160902`. Creó los ocho roles y membresía SET ROLE de postgres; sin embargo, los grants de objetos no resultaron efectivos porque postgres tiene SET y no INHERIT de los owners. La primera prueba falló con `42501 permission denied for schema promotions`; no persistió el fixture.

Se preparó una corrección incremental en `access/owner-grants.sql`, conservando el SQL original de `access/provision.sql`. Su revisión automática primero no pudo completarse por límite de uso y luego exigió aprobación específica del SQL modificado. Se obtuvo esa aprobación y se aplicó `infra_001_seed_access_owner_grants`, versión `20261013161315`, con SET LOCAL ROLE explícito de cada owner y assertions de permisos. No se eludió ninguna revisión ni se usó execute_sql para aplicar DDL.

Postcheck de accesos: **8 roles NOLOGIN/NOINHERIT**, todos sin superuser, createdb, createrole, replication ni bypassrls; **8 USAGE propios**, **0 accesos cross-schema**, **0 CREATE de objetos**, **0 membresías de los seed roles**. Solo po_promotions_seed puede SELECT/INSERT en las seis columnas autorizadas; no tiene permiso de UPDATE, DELETE, TRUNCATE ni acceso a timestamps. Los demás seed roles no pueden escribir tablas. Se verificó con has_schema_privilege/has_column_privilege; information_schema.column_privileges no mostraba los grants por visibilidad del auditor y no se tomó ese resultado como ausencia de permisos.

Prueba T07: **PASS en Supabase existente**. El SQL generado por el ejecutor se ejecutó mediante MCP en una única transacción, con `SET LOCAL ROLE po_promotions_seed`. Dos ejecuciones del INSERT y sus assertions dejaron **1 fila** de fixture y devolvieron `SEED_VALIDATED`; las constraints diferidas se validaron antes de ROLLBACK. No se hicieron escrituras en schemas ajenos.

Postcheck después de ROLLBACK:

```text
stock_projection_rows = 0
fixture_rows = 0
stock_projection_data_hash = d41d8cd98f00b204e9800998ecf8427e (igual al baseline)
table_structure_hash = 8ffd8c47617a179f9f832757a0d2d1e5 (igual al baseline)
schema_owners = los mismos ocho owners del baseline
```

La prueba acredita el SQL generado y el rol seed restringido a través del MCP autenticado; **no acredita la conexión psql de un login individual**. El cliente psql no estaba instalado en PATH y no había variables de credenciales/CA de carga disponibles. Logins individuales y contraseñas: **NO PROVISIONADOS**, entrega por administrador fuera de Git pendiente. No se introdujeron secretos reales en archivos ni se ejecutó un seed persistente.

## Advisors y dependencias específicas

`get_advisors(type=security)` se ejecutó antes y después: mismos 23 avisos preexistentes `function_search_path_mutable` (Taxonomía 8, Catálogo 8, Inventario 3, Bulk 4). [Remediación oficial](https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable). No se alteraron funciones ajenas para resolverlos ni se añadieron funciones persistentes nuevas.

`npm audit --json` confirmó 5 dependencias del lockfile previo con avisos, dentro de la cadena dev @nestjs/mau: tmp y undici (high), @nestjs/mau (moderate), external-editor e inquirer (low). El ejecutor usa módulos nativos y no importa esas dependencias. Actualizar dependencias globales no está autorizado por el issue, y no se ejecutó audit fix --force. Los avisos no se presentan como resueltos: requieren revisión separada del owner de Foundation.

| Owner | Operación afectada | Condición verificable de desbloqueo |
| --- | --- | --- |
| Administrador autorizado del proyecto | Acceso individual psql | Provisionar login por owner, entregar credencial por canal privado, configurar CA/destino del panel y ejecutar CLI con ese login. |
| Leonardo López, Gabriel Poma, Leonardo Vera, Miguel Taco y Marco Castilla, cada uno en su contexto | Cargas propias y dataset integrado | Aprobar identificadores, registrar seeds/allowlist/grants de columnas propios y demostrar cargas idempotentes sin accesos cruzados. No bloquea el ejecutor de Promociones. |
| Leonardo López, Gabriel Poma, Miguel Taco y Marco Castilla | Funciones con search_path mutable de sus schemas | Revisar cada aviso y entregar una corrección incremental de su owner con prueba, fuera del alcance de este issue. |
| Marco Castilla / Foundation | Dependencias de desarrollo preexistentes | Revisar los 5 avisos de npm audit y autorizar un cambio global separado con validación. |
| Leonardo López / Marco Castilla | Revisión formal y criterio del PR | Checks obligatorios sin errores y revisión técnica/de integración verificable. |

## Estado por tarea y por entorno

| Tarea | Estado |
| --- | --- |
| T01 auditoría | PASS de lectura real; owners/tablas/ACL/FK revisados. |
| T02 accesos | PARTIAL: grupos/grants aplicados y aislados; logins y entrega privada de credenciales pendientes. |
| T03 conexión | PARTIAL: plantilla/SSL y acceso MCP comprobados; psql individual pendiente. |
| T04 estructura | PASS local. Los otros owners aún deben aportar sus cargas. |
| T05 ejecutor | PASS pruebas enfocadas y SQL generado ejecutado con rol restringido. CLI psql individual aún pendiente. |
| T06 dataset | PARTIAL: manifiesto preparado, revisión de owners/cargas no acreditada. |
| T07 prueba Supabase | PASS: dos ejecuciones, 1 fila, rollback y postcheck sin cambios de datos/estructura/owners. |
| T08 documentación/evidencia/PR | PARTIAL: documentación/evidencia entregadas; revisión técnica/de integración y cierre pendientes. |

Implementación interna: entregada y comprobada con pruebas enfocadas.
Pruebas locales generales: PASS; npm audit reporta avisos preexistentes separados.
Integración autenticada: auditoría MCP y prueba del rol seed sí; psql individual no.
Homologación externa: no requerida para el ejecutor; aprobación de datasets por owners pendiente.
Despliegue: roles/grants aplicados; ningún dato seed persistente ni microservicio desplegado por esta tarea.
Estado final actual: **PARTIAL**, por logins individuales, aprobación de dataset y revisión formal pendientes; no cierre del issue.
