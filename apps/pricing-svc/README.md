# pricing-svc — configuración y persistencia (#52, #53)

Owner: Leonardo Vera, rama `vera`. Alcance operativo: `IMPLEMENTAR_AHORA`.

## Configuración y ejecución

Se conservan los scripts del monorepo: `npm run build:pricing-svc`,
`npm run start:pricing-svc` y `npm run start:dev:pricing-svc`.
Usar la versión de Node indicada en `package.json`. El ejecutable carga `.env`
de la raíz si existe; las variables de la sesión tienen precedencia.

| Variable | Descripción | Obligatoria |
|---|---|---|
| `NODE_ENV` | Entorno: `development`, `test` o `production`. | Sí |
| `PRICING_SVC_PORT` | Puerto HTTP entero entre 1 y 65535; prioridad sobre `PORT`. Puerto asignado a Pricing: 3002. | Sí, salvo que exista `PORT` |
| `PORT` | Alternativa cuando no se define el puerto propio. No sustituye un puerto propio inválido. | Condicional |
| `DATABASE_URL` | Conexión PostgreSQL directa/pooler para el rol runtime de Pricing, con host, usuario y base. Inyectar desde la sesión o gestor de secretos. | Sí |
| `PGSSLMODE` | Alternativa al parámetro `sslmode` de la URL. Se exige `verify-full` en producción y para hosts remotos. | Condicional |
| `PGSSLROOTCERT` | Ruta a la CA PEM del proveedor; alternativa a `sslrootcert` en la URL. Si se declara, debe existir y ser un certificado válido. | Para CA no incluida en la confianza de Node |

No hay valores implícitos para variables obligatorias. Configuración ausente o
malformada impide crear Nest/abrir el listener y termina con código 1. No se
imprime el valor rechazado. Los errores al cargar `.env` o abrir el listener
también se informan con un mensaje fijo sin el error original.
Se exige `sslmode=verify-full` en producción, incluso en localhost. También se
exige para hosts remotos en desarrollo/test. Se rechazan modo ausente,
`disable`, `allow`, `prefer`, `require`, `verify-ca` y `no-verify` en esas conexiones.
Solo localhost/loopback fuera de producción admite modo ausente o `disable`
para pruebas aisladas. Una URL admite únicamente `sslmode` y `sslrootcert`,
sin duplicados ni overrides del host/SSL. Antes de crear el pool se eliminan
esos parámetros y se pasa TLS explícito con `rejectUnauthorized: true` y
`checkServerIdentity` de Node; el parser de pg no puede sustituir esa política.
La CA configurada se valida y carga al arrancar. Si no se declara, se utiliza
la confianza de Node; una CA no confiable falla la conexión, sin fallback.
También se rechaza validación TLS global desactivada. No usar credenciales owner/deployer, claves del
frontend ni acceso a schemas ajenos. No se cambia exposición de puertos.

## Sondas operativas

| Ruta | Significado | Resultado |
|---|---|---|
| `GET /health` | Liveness existente, preservado para infraestructura. | 200, `status=ok` |
| `GET /health/live` | Liveness de Arquitectura §25; no consulta dependencias. | 200, `status=ok` |
| `GET /health/ready` | Disponibilidad de PostgreSQL y lectura de `pricing.prices`. | 200, `status=ready`; 503, `status=not_ready` |

Todas las respuestas identifican `service=pricing-svc`. Readiness ejecuta
`SELECT 1 FROM pricing.prices LIMIT 0`: comprueba conexión y acceso a una tabla
propia, sin leer filas ni escribir datos. Una base caída, schema/tabla ausente
o permisos insuficientes produce 503; liveness sigue en 200. No acredita todas
las tablas, grants de escritura ni funcionalidades de precios.
El pool limita conexiones a 2 y tiempos de conexión/consulta a 2 segundos
cada uno; se libera al cerrar la aplicación y en señales de apagado de Nest.
No hace fan-out a otros servicios. Broker no es dependencia de este scaffold:
no hay consumers, relay ni operaciones de negocio implementados en #52.

## Logging y fuentes

Logs JSON con servicio y entorno. No se registran configuración, requests,
objetos, errores/stack originales ni payloads. El logger solo acepta una lista
cerrada de mensajes técnicos internos y contextos controlados. Redacta cualquier
otro mensaje, argumento o entorno, aunque sea texto sin prefijos reconocibles.
No usa expresiones regulares para decidir qué contenido es seguro. Mantiene
timestamp, nivel, servicio y entorno validado; las pruebas verifican stdout y
stderr con secretos ficticios arbitrarios. Añadir mensajes exige revisar la lista.

Fuentes oficiales consultadas en `Taller-SW-Web/G6-Productos-Ofertas-docs`
(master `c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b`):
[Arquitectura §§24–25](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/master/arquitectura/Arquitectura.md),
[SPEC-013](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/master/requisitos/specs/SPEC-013-gestion-precios-individuales-masivos.md),
HU/FLOW-013 y `datos/pricing/physical-model.md`.
Se revisaron registro DEC-F, trazabilidad y matriz intermodular: DEC-F-006
delimita la autoridad de Pricing; DEC-F-001 aporta la identidad SKU y DEC-F-012
la gobernanza contractual. Sus reglas de negocio quedan fuera de este bloque.
OpenAPI `0.6.0-rc.1` y AsyncAPI `0.6.0-rc.2` son candidatos consultados en master;
no se modifican contratos ni se infiere homologación externa.

## Validación y límites de evidencia

Pruebas enfocadas: `npm test -- apps/pricing-svc` y
`npm run test:e2e -- apps/pricing-svc`. Cubren configuración, errores sanitizados,
sondas independientes, recuperación simulada y PostgreSQL local inaccesible.
Los dobles de prueba se inyectan solo en tests, nunca en ejecución normal.
Implementación local no equivale a integración PostgreSQL/Supabase autenticada,
homologación, despliegue ni cierre del issue: requieren evidencia separada.

Evidencia local del 2026-10-16, Node 24.19.0: `npm test` pasó 159 pruebas;
`npm run test:e2e` pasó 337 y omitió 13 por condiciones de entorno.
`npm run typecheck`, `npm run lint`, `npm run format:check`,
`npm run build:pricing-svc` y `git diff --check`: PASS.
Smoke del ejecutable con fixtures locales: liveness 200, readiness 503 ante
PostgreSQL inaccesible, logs JSON sin la credencial ficticia; configuración
inválida termina con código 1 sin mostrar el valor rechazado. El caso ready
200 está probado con doble inyectado, no con PostgreSQL autenticado real.

### Correcciones de auditoría del PR #121

Se añadieron pruebas de producción sin TLS, modos inseguros, CA ilegible/inválida,
overrides del parser de pg y secreto arbitrario sin etiquetas en stdout/stderr.
Pricing: 55 unitarias y 3 E2E aprobadas. El smoke del ejecutable en producción
con `verify-full` y DB inaccesible mantuvo health/live=200 y readiness=503;
sin TLS, con `disable` o con `require` terminó con código 1 sin filtrar el secreto.
Regresión general de la rama: 180 unitarias aprobadas; 337 E2E aprobadas y
13 omitidas por condiciones de entorno. Typecheck, lint, formato, build de
Pricing y revisión de whitespace: PASS. La integración con master se verifica
adicionalmente en el commit de merge de GitHub y en el CI del mismo PR.

Prueba autenticada de solo lectura con las credenciales runtime existentes:
rol esperado confirmado, transacción READ ONLY, consulta sin filas a
`pricing.prices`, TLS 1.3 autorizado y `/health`, `/health/live`, `/health/ready`
en 200. Sin mutaciones, cambios de credenciales, grants ni configuración Supabase.
La confianza de Node sola rechazó la cadena del proveedor; con la CA oficial,
certificado y hostname se verificaron correctamente. La CA se descargó a un
archivo temporal y se eliminó al terminar; no se modifica `.env` ni se incorpora
ningún certificado al repositorio. La ruta de CA declarada en el `.env` local no
existe en este equipo: para operar debe provisionarse una ruta válida.

Fuente de CA: URL de producción publicada por
[Supabase Studio](https://github.com/supabase/supabase/blob/7425d4930528931400fb3e656e860b1094cb224e/apps/studio/hooks/custom-content/custom-content.json).
SHA-256 del certificado: `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`.
La integración autenticada puntual no acredita homologación ni despliegue.

## Persistencia Drizzle (#53)

Alcance operativo: `IMPLEMENTAR_AHORA`, exclusivamente `apps/pricing-svc`.
Prerrequisito #52: [PR #121 fusionado](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/pull/121).
Base de implementación: `79a03c02f82722c599a9963b7340c088eba8f5b4`, rama `vera`.

`PricingDatabase` mantiene un único pool runtime para Drizzle y readiness,
con cierre por el ciclo de Nest. Conserva TLS validado, límites y timeouts
del bloque #52; fija `search_path=pg_catalog,pricing` y desactiva logging SQL.
`PricingRepository` se inyecta/exporta desde el módulo. Consulta definiciones
por producto **o** SKU y canal exacto (incluido global), y snapshots por definición.
No resuelve herencia/fallback ni consulta Catálogo.

`transaction(callback)` entrega un `PricingTransaction` tipado para insertar
o actualizar snapshots, programación, lotes y mensajería dentro del mismo
commit. El caller debe incluir el hecho Outbox y, cuando corresponda, Inbox
en esa transacción. No hay publicación al broker ni eventos fabricados por
triggers. La suite demuestra commit/rollback conjunto y CAS concurrente;
el caso de uso deberá convertir cero filas actualizadas en `VERSION_CONFLICT`.
Los errores DB se convierten en `PricingPersistenceError` con mensaje fijo y
SQLSTATE cuando existe, sin SQL, parámetros, credenciales, detalle ni causa
original. Los errores propios del callback conservan identidad tras rollback.

### Mapping y fuente del DDL

`src/persistence/pricing.schema.ts` mapea las siete tablas de
[`datos/pricing/physical-model.md`](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/datos/pricing/physical-model.md):

| Elemento | Tabla |
|---|---|
| Definición y versión | `pricing.prices` |
| Snapshot monetario y vigencia | `pricing.price_validities` |
| Programación vinculada a snapshot | `pricing.scheduled_prices` |
| Lote local y filas durables | `pricing.bulk_price_jobs`, `pricing.bulk_price_rows` |
| Mensajería transaccional | `pricing.outbox`, `pricing.inbox` |

Versiones `bigint` permanecen `bigint` de JavaScript; importes `numeric(12,2)`
permanecen strings decimales. El encoder monetario rechaza más de dos decimales,
desbordes y valores no decimales antes del cast de PostgreSQL para evitar
redondeo silencioso. Positividad, oferta, coherencia temporal y demás checks
siguen en el SQL normativo.

El mapping declara PK, UNIQUE (incluido NULLS NOT DISTINCT), FK internas,
checks e índices. No genera/aplica DDL ni sustituye la exclusion GiST o los
triggers diferidos de la migración oficial. No hay segundo historial de
migraciones en backend. `test/fixtures/pricing.sql` es una copia de prueba del
[SQL oficial](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/datos/pricing/migrations/0001_create_pricing.sql),
sin cambios de contenido. SHA-256 con saltos LF:
`7f440ffa401e8d56ecb2664060edb131505a16b8568843093a5047a6c13bc581`.
La suite verifica ese checksum antes de ejecutarlo.

Se consultaron Arquitectura §§7/9/16, Modelo Conceptual §5, SPEC/HU/FLOW-013,
registro y matrices DEC-F e intermodular del mismo commit documental.
Aplican DEC-F-001 (identificadores externos), 006 (autoridad, versión y vigencia),
009 (Inbox/Outbox e identidad de transporte, sin prometer idempotencia de negocio
completa) y 012 (fuentes/versionado/migraciones inmutables).
OpenAPI `0.6.0-rc.1` y AsyncAPI `0.6.0-rc.2` siguen candidatos sin cambios.
El payload genérico de los hechos no se concreta en este bloque.
Referencias de implementación: [tipos PostgreSQL](https://orm.drizzle.team/docs/column-types/pg)
y [transacciones Drizzle](https://orm.drizzle.team/docs/transactions).

### Reproducción de pruebas aisladas

Requiere Node compatible con `package.json`, dependencias instaladas y Docker
activo con contenedores Linux. No requiere `.env`, credenciales compartidas,
un proyecto Supabase ni una URL de base de datos externa.

```powershell
npm test -- apps/pricing-svc
$env:PRICING_TEST_POSTGRES = '1'
npm run test:e2e -- apps/pricing-svc --reporter=verbose --silent=false
Remove-Item Env:PRICING_TEST_POSTGRES
```

La suite crea una instancia PostgreSQL por suite, no por test, con imagen fijada:
`postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea`.
Si falta localmente, Docker debe poder descargarla. Solo el puerto aleatorio de
la fixture se publica en loopback; no se publican servicios internos ni broker.
La preparación de roles/ACL y extensión ocurre exclusivamente en ese contenedor.
Las operaciones del repositorio usan `pricing_app`, sin membresía owner.
Al terminar se cierran conexiones y se elimina el contenedor con sus volúmenes.
No se aceptan URLs externas para preparar fixtures, ni se escriben datos,
credenciales, grants o policies de Supabase.

Sin `PRICING_TEST_POSTGRES=1`, las 13 pruebas PostgreSQL se marcan omitidas;
esa ejecución no acredita persistencia. Con la variable activa, falta de Docker,
errores de fixture o de permisos hacen fallar la suite. El workflow compartido
no se modifica en este issue; la evidencia local siguiente sí activa la suite.

### Evidencia local del 2026-10-17

Entorno: Windows, Node `24.19.0`, Vitest `4.1.11`, PostgreSQL `16.15` real en
Docker. Sin conexión ni escritura a Supabase durante #53.

| Comando | Resultado |
|---|---|
| `npm test -- apps/pricing-svc` | PASS: 71 unitarias |
| `PRICING_TEST_POSTGRES=1 npm run test:e2e -- apps/pricing-svc` | PASS: 16 E2E, incluidas 13 PostgreSQL; sin omitidas |
| `npm test` | PASS: 196 unitarias |
| `PRICING_TEST_POSTGRES=1 npm run test:e2e` | PASS: 350 pruebas; 13 omitidas preexistentes de otras suites por entorno |
| `npm run typecheck` | PASS |
| TypeScript estricto de las nuevas pruebas de repositorio y E2E | PASS |
| `npm run lint` | PASS |
| `npm run format:check` | PASS |
| `npm run build:pricing-svc` | PASS |
| `git diff --check` | PASS |

Las pruebas PostgreSQL comparan todas las columnas/tipos/nullabilidad y las tres
FK internas; verifican UNIQUE, precisión monetaria, XOR de objetivo, intervalos,
CAS con dos conexiones, coherencia de programación/lotes, deduplicación y
rollback de precio/Inbox/Outbox, incluido fallo diferido en COMMIT. Se comprueban
SELECT/INSERT/UPDATE efectivos por tabla y denegación de DELETE/TRUNCATE/DDL,
UPDATE a Inbox, lectura de otro schema y SET ROLE al owner.

Implementación interna y pruebas locales: completadas. Provider y readiness
contra PostgreSQL aislado autenticado: comprobados. Integración compartida
Supabase, homologación externa y despliegue de #53: no ejecutados. El cierre
del issue requiere revisión/aceptación y PR fusionado según su definición de
terminado. No se agregan endpoints, handlers, workers, parser ni resolver del #54.
