# PostgreSQL runtime — verificación real Taxonomy/Catalog

16/10/2026, 13:27 America/Lima. Rama de auditoría `castilla`, SHA `7b15faeb421e7a54bfbf3e8250d6718023dcc3bb`; #19/#22/#23/#26 y BACK #34–#37/#43–#46 consultados nuevamente. No se editaron issues oficiales.

**Conectividad y lecturas runtime verificadas mediante PostgreSQL real y Drizzle. Los permisos SELECT no son una dependencia pendiente.** CRUD fue confirmado por Marco; esta auditoría verifica exclusivamente SELECT, no ejecuta ni certifica INSERT/UPDATE/DELETE.

| Comprobación                                                   | Taxonomy                                                                                                           | Catalog                                                                                   |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Configuración privada                                          | `C:\Users\marec\Desktop\G6-PostgresRuntime-Privado\taxonomy\.env.local`                                            | `C:\Users\marec\Desktop\G6-PostgresRuntime-Privado\catalog\.env.local`                    |
| Identidad PostgreSQL observada                                 | `taxonomy_dev_login`                                                                                               | `catalog_dev_login`                                                                       |
| Autenticación/base esperadas                                   | PASS                                                                                                               | PASS                                                                                      |
| TLS, CA, hostname verificados                                  | PASS                                                                                                               | PASS                                                                                      |
| Hostname incorrecto rechazado                                  | PASS                                                                                                               | PASS                                                                                      |
| USAGE en schema propio                                         | PASS                                                                                                               | PASS                                                                                      |
| SELECT mediante Drizzle                                        | PASS, 2 tablas                                                                                                     | PASS, 11 tablas                                                                           |
| Otros siete schemas                                            | PASS: USAGE denegado y SELECT rechazado, SQLSTATE 42501                                                            | PASS: USAGE denegado y SELECT rechazado, SQLSTATE 42501                                   |
| Usuario no administrativo y sin membresía del owner del schema | PASS                                                                                                               | PASS                                                                                      |
| Loader/provider NestJS                                         | Pendiente de conexión real. `origin/lopez` ya tiene handlers/puerto, pero inyecta `UnconfiguredTaxonomyRepository` | Pendiente. `origin/poma` solo publica README; scaffold existe en baseline master/castilla |
| Próxima acción                                                 | López conecta Drizzle al puerto existente                                                                          | Poma configura proceso y crea provider/repositorios propios                               |

CA referenciada por ambos archivos: `C:\Users\marec\AppData\Local\G6\PostgresRuntime\supabase-server-root.crt`, existente y usada con validación estricta. Host, puerto, base, contraseña y usuario de conexión se consumieron directamente del archivo, sin volcarlos al informe. Se respetó `G6_CONNECT_HOST` para conexión y `PGHOST` para hostname TLS, sin sustituir configuración. No se copiaron ni modificaron `.env` ni certificados.

Tablas verificadas con `SELECT * ... LIMIT 1` (sin mostrar ni guardar filas):

- Taxonomy: `taxonomy.categories`, `taxonomy.brands`.
- Catalog: `catalog.products`, `variants`, `sku_identity`, `product_images`, `variant_images`, `product_attribute_values`, `variant_attribute_values`, `product_identifying_characteristics`, `sku_physical_profiles`, `activation_checks`, `master_barriers`.

Las dos primeras cubren #22; las once de Catalog cubren datos de lectura y auxiliares propios de preparación/físico. La lectura no certifica elegibilidad, activación, imágenes válidas ni completitud de fixtures. No se consultaron tablas de negocio ajenas: los intentos negativos LIMIT 0 fueron rechazados; la selección de tabla negativa se hizo por metadata de PostgreSQL, sin adivinar nombres.

## Evidencia reproducible

[Probe de solo lectura](test/postgres-runtime.readonly.mjs), [resultado Taxonomy](test/evidence/postgres-taxonomy-2026-10-16.json), [resultado Catalog](test/evidence/postgres-catalog-2026-10-16.json). Los JSON contienen estados, rutas, nombres de rol/tablas y hash del probe, sin secretos ni datos comerciales. Node v24.19.0, `pg` local 8.23.1, Drizzle local 0.45.4; dependencias locales reutilizadas, no instalación limpia. El package.json/lock versionado de la rama actual no declara estos adaptadores; disponer de node_modules no resuelve esa dependencia reproducible de los providers.

Desde la raíz Backend, con Node soportado y dependencias disponibles:

```powershell
node apps/api-gateway/test/postgres-runtime.readonly.mjs taxonomy
node apps/api-gateway/test/postgres-runtime.readonly.mjs catalog
```

Ambos terminaron con código 0 y `PASS_READONLY_DRIZZLE`. Se ejecutó únicamente SQL SELECT. `serverDefaultReadOnly=false` es informativo: los roles tienen CRUD según la actualización de infraestructura; la ausencia de escrituras la garantiza el conjunto de consultas del probe, no una restricción read-only del usuario. El primer intento del probe exigía una opción startup read-only que no quedó reflejada en la sesión; se retiró esa suposición, sin alterar servidor ni archivos privados. Los JSON enlazados corresponden al probe final identificado por hash.

Sintaxis Node, oxlint del probe, formato y enlaces relativos comprobados. No se cambiaron apps de otros owners ni configuración compartida. No se reejecuta build Nest por un harness externo sin cambios TypeScript. No hay commit/push/merge/deploy ni SQL de permisos.

Inyección real `node --env-file` comprobada en dos procesos separados: `PASS_ENV_INJECTION_CATALOG` y `PASS_ENV_INJECTION_TAXONOMY`; las aserciones de schema/rol esperado, presencia de contraseña y TLS pasaron sin imprimir valores. Ambos archivos declaran modo session y su referencia de conexión coincide con PGHOST. Esto verifica la inyección de Node, todavía no un provider de Nest. La opción está documentada en [Node CLI](https://nodejs.org/api/cli.html#--env-filefile); la integración recomendada usa el [adaptador PostgreSQL de Drizzle](https://orm.drizzle.team/docs/get-started/postgresql-new). Se comprobó además que ninguna contraseña de esos archivos aparece en los artefactos generados.

## Dependencias vigentes

| Trabajo                                     | Estado y responsable                                                                                                                                |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credenciales, CA, conexión, USAGE y SELECT  | Verificados para ambos; retirados de bloqueos. No preparar grants                                                                                   |
| Dependencias versionadas pg/Drizzle y tipos | Revisar package.json/lock de la rama de cada owner. Si faltan, requiere autorización expresa para archivos compartidos; no basta node_modules local |
| Configuración/provider/repositorios Nest    | IMPLEMENTAR_AHORA en `lopez`/`poma`, con alcance #34/#35 y #43/#44; vincular evidencia y respetar coordinación de etapas BACK                       |
| Elegibilidad D-CAT-05/06                    | BLOQUEADO_ESPECÍFICO de exposición comercial por canal; no bloquea conexión, repositorios ni consultas internas definidas                           |
| Marca en detalle Catalog                    | Frontera contractual Taxonomy; no consultar su schema desde Catalog                                                                                 |
| HTTP real del MVP                           | Handlers conectados, fixtures válidos y Gateway #116. G7 sigue siendo frontera HTTP distinta; credenciales PostgreSQL no son JWT del BFF            |

## Instrucción para el agente de Poma

Trabaja solo en tu rama personal `poma`, `apps/catalog-svc`, con #43/#44 y trazabilidad #23/#45/#46. Lee AGENTS y fuentes normativas; verifica SHA y dirty actual. Al corte `origin/poma=42b5143db14d2722e6f37d8a4ef41f02eded03b5` solo tiene README: recupera coordinadamente el scaffold existente, sin crear otra app ni sincronización masiva automática. No toques Taxonomy ni Gateway.

1. Reutiliza exclusivamente `C:\Users\marec\Desktop\G6-PostgresRuntime-Privado\catalog\.env.local`. No copies ni edites el original. Valida PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD, PGSSLMODE, PGSSLROOTCERT, G6_DATABASE_SCHEMA, G6_EXPECTED_ROLE y G6_CONNECTION_MODE antes de abrir puerto. Mantén la semántica G6_CONNECT_HOST/PGHOST comprobada. Prohíbe credenciales owner/seed/admin.
2. Inyecta configuración **antes** de importar/arrancar Nest. Para ejecución compilada, el comando siguiente usa el archivo externo sin loader implícito ni copia. El loader actual de raíz `.env` no equivale a leer esta carpeta. Configuración heredada del proceso tiene precedencia: rechaza incoherencia de rol/schema/host en lugar de mezclar identidades.

```powershell
node --env-file="C:\Users\marec\Desktop\G6-PostgresRuntime-Privado\catalog\.env.local" dist/apps/catalog-svc/main.js
```

3. Implementa provider propio `pg.Pool` + `drizzle-orm/node-postgres`, CA explícita y `rejectUnauthorized=true`, hostname PGHOST, pool acotado, timeout y cierre `pool.end()` mediante lifecycle Nest. Valida identidad/base/schema al conectar; no uses URI con password en argumentos/logs. Usa esquema Drizzle de `catalog` y tipos del modelo físico; no `drizzle-kit push`, migraciones nuevas ni cambios de permisos. Si dependencias compartidas no están autorizadas, solicita solo ese alcance, manteniendo preparados los archivos propios.
4. Implementa repositorios con proyección explícita y consultas parametrizadas para productos, variantes, SKU, imágenes y atributos, filtros/paginación definidos. Conserva puertos para dependencias externas; cero JOIN cross-schema, mocks runtime o arrays de respaldo. No publiques ACTIVO como elegible. D-CAT-05/06 queda aislada; continúa las demás consultas definidas sin afirmar terminado el catálogo comercial.
5. Añade una prueba de integración del provider/repo propio que lea el schema real con runtime y registre solo estado/correlación, nunca filas/DSN/errores completos. Repite negativos TLS, config ausente e indisponibilidad; usa una DB aislada para caídas/escrituras/transacciones, nunca modifiques este proyecto. Ejecuta pruebas enfocadas, typecheck, lint, formato y build de Catalog. El probe externo no sustituye esta prueba Nest/Drizzle.
6. Cuando haya handlers, política aprobada y fixtures válidos, coordina `marketplace.live.mjs` con Marco. No inventes PASS HTTP. Sin commits/push/merge/deploy en esta etapa; informa SHA/diff y límites.

## Instrucción para el agente de López

Trabaja solo en `lopez`, `apps/taxonomy-svc`, con #34/#35 y trazabilidad #22/#36/#37. Verifica SHA/dirty y reutiliza tu trabajo publicado `4c1214862d106b66f9892bfc72e14450a6b31406`: ya existen `TaxonomyController`, `TaxonomyRepository` y el token `TAXONOMY_REPOSITORY`. No rehagas handlers, DTOs ni los datos de #18.

1. Reutiliza exclusivamente `C:\Users\marec\Desktop\G6-PostgresRuntime-Privado\taxonomy\.env.local`; valida las mismas variables existentes, identidad `taxonomy_dev_login` y schema `taxonomy`, sin copiar/editar el archivo. Inyección previa a Nest:

```powershell
node --env-file="C:\Users\marec\Desktop\G6-PostgresRuntime-Privado\taxonomy\.env.local" dist/apps/taxonomy-svc/main.js
```

2. Implementa `pg.Pool` + Drizzle y mapping propio de `taxonomy.categories`/`brands`, con TLS estricto y ciclo de vida descritos para Poma. Reemplaza en el módulo la vinculación de `UnconfiguredTaxonomyRepository` por el adaptador real que implemente **el puerto ya existente**. Configuración ausente o conexión/permisos/TLS fallidos deben fallar cerrado, sin usar repositorio de prueba en runtime. No declares readiness por un `/health` vivo ni inventes rutas.
3. `findCategoriasActivas()`/`findMarcasActivas()` consultan `estado='ACTIVO'` en DB con proyección explícita. No mapees PENDING_DEACTIVATION a ACTIVA. Reutiliza mappers, respuestas y Problem Details existentes; corrige únicamente lo necesario conforme OpenAPI. No modifiques Catalog, contratos, migraciones, datos ni grants.
4. Añade integración Nest→provider→Drizzle→PostgreSQL con runtime real y lecturas de categorías/marcas; usa los tests existentes como base. Valida vacíos/inactivas/pendientes en suite aislada y errores sin fuga. Ejecuta pruebas enfocadas, typecheck, lint, formato y build Taxonomy. Autenticación HTTP técnica sigue conservada en la frontera del Gateway: este probe no la acredita.
5. Verifica dependencias versionadas con el mismo límite de archivos compartidos; informa solo el bloqueo concreto si falta autorización. Entrega SHA/diff y resultado real; no hagas commits/push/merge/deploy. Cuando el adaptador funcione, coordina Gateway #116→Taxonomy y luego smoke de tres operaciones cuando Catalog/fixtures estén listos.
