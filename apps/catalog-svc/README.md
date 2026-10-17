# catalog-svc — configuración y salud (#43)

Owner: Gabriel Poma, rama `poma`. Código en `apps/catalog-svc`; incorporación de
`pg` y `@types/pg` a las dependencias raíz autorizada expresamente por el usuario.

## Configuración

`CatalogConfig` centraliza y valida la configuración antes de crear Nest. La
instancia es inmutable. No hay defaults silenciosos para variables obligatorias.

| Variable | Requisito y descripción |
| --- | --- |
| `NODE_ENV` | Obligatoria: `development`, `test` o `production`. |
| `CATALOG_SVC_PORT` | Puerto HTTP interno obligatorio, entero decimal entre 1 y 65535. |
| `PORT` | Alternativa solo si `CATALOG_SVC_PORT` no existe. Un valor específico inválido no usa fallback. |
| `PGHOST` | Host PostgreSQL/Session Pooler obligatorio en modo PG. |
| `PGPORT` | Puerto PostgreSQL obligatorio, entero decimal entre 1 y 65535. |
| `PGDATABASE` | Nombre de la base del servicio, obligatorio en modo PG. |
| `PGUSER` | Identidad propia de Catálogo; en Supavisor incluye el sufijo del proyecto. |
| `PGPASSWORD` | Contraseña privada de esa identidad, obligatoria en modo PG. |
| `PGSSLMODE` | Obligatoria: `verify-full`; no se acepta desactivar la validación TLS. |
| `PGSSLROOTCERT` | Ruta absoluta a un certificado CA existente, legible y no vacío. |
| `G6_DATABASE_SCHEMA` | Obligatoria en modo PG: `catalog`. |
| `G6_CONNECTION_MODE` | Obligatoria en modo PG: `session`. |
| `DATABASE_URL` | Alternativa para entornos sin variables PG: URL PostgreSQL con host y base. No sustituye variables PG incompletas ni se usa para el Session Pooler de la guía. |

Desde la raíz, el proceso carga `apps/catalog-svc/.env.local` y después `.env`, sin
sobrescribir variables ya definidas: entorno del proceso > archivo del servicio >
archivo raíz. No hace falta modificar scripts compartidos para cargar el archivo
del servicio. `.env.local` está ignorado por Git; nunca versionar credenciales.
La configuración inválida impide
el arranque y termina con código 1. Los errores de validación solo contienen
nombres y requisitos; el fallo de bootstrap emite un mensaje fijo, sin stack ni
valores del entorno. El logger JSON redacta secretos por clave, URLs completas,
Bearer/JWT, objetos Error, valores sensibles del entorno y credenciales de la URL.
Las requests generan o preservan `X-Correlation-Id` (1–128 caracteres alfanuméricos,
punto, guion o subrayado); entradas inválidas se reemplazan por un UUID.

## Health y readiness

| Ruta interna | Comportamiento |
| --- | --- |
| `GET /health` | Compatibilidad con scaffold: 200, `{"status":"ok","service":"catalog-svc"}`. |
| `GET /health/live` | Alias normativo de liveness: confirma proceso HTTP vivo, sin dependencias remotas. |
| `GET /health/ready` | 200 solo después de una comprobación satisfactoria de la dependencia de persistencia. Fallo, ausencia o timeout de 2 s producen 503 con `not_ready` y `database: unavailable`, sin detalle sensible. |

Se aplica Arquitectura §25; `/health/readiness` de Taxonomía no sustituye la ruta
normativa `/health/ready`. No hay nuevas rutas comerciales ni cambios al gateway.

`AppModule.forRoot` conecta `CatalogDatabase` a `PostgresReadiness`, usando `pg`
sin ORM, migraciones ni CRUD. Cada sondeo abre una conexión autenticada y consulta
`current_user`, `current_database()` y los permisos `USAGE`/`CREATE` de `catalog`.
Solo responde ready si coinciden rol y base esperados, existe USAGE y no existe
CREATE. En Supavisor el sufijo del proyecto no forma parte de `current_user`.
La conexión exige CA y verificación del hostname en modo Session Pooler; los
timeouts de conexión y consulta son de 1 s, dentro del límite HTTP de 2 s. La
conexión se cierra en éxito o error; un éxito previo no se conserva como caché.

Importar el módulo sin configuración mantiene el indicador explícitamente no
configurado y responde 503. Los adaptadores simulados solo existen en tests.

No se verifica RabbitMQ: este bloque no admite comandos, publica eventos ni
inicia consumers. Al conectar esas capacidades habrá que comprobar su broker.
No se hace fan-out a Taxonomía, Pricing o Inventario ni acceso cross-schema.

## Ejecución y pruebas

Desde la raíz, con las variables anteriores suministradas de forma segura:

```sh
npm ci
npm run build:catalog-svc
npm run start:catalog-svc
# Desarrollo:
npm run start:dev:catalog-svc
# Pruebas enfocadas:
npm test -- apps/catalog-svc
npm run test:e2e -- apps/catalog-svc
# Validaciones generales:
npm test
npm run test:e2e
npm run typecheck
npm run lint
npm run format:check
git diff --check
```

Las pruebas de configuración y logging usan secretos ficticios. Los tests HTTP
arrancan Nest en puertos locales efímeros y cierran las aplicaciones. No escriben
en Supabase, no ejecutan migraciones ni necesitan servicios cloud.

## Fuentes y estado operativo

- [Issue #43](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/43).
- [Guía de desarrollo PostgreSQL](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/ops/postgres-runtime/guia-desarrollo-local.md): variables PG, Session Pooler, CA y consultas de permisos.
- [TLS de node-postgres](https://node-postgres.com/features/ssl) y [configuración del cliente](https://node-postgres.com/apis/client): opciones SSL y timeouts.
- [Arquitectura](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/master/arquitectura/Arquitectura.md), §§4, 7, 23–25.
- [Modelo de Catálogo](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/master/datos/catalog-svc/physical-model.md), §§1–5: schema y credenciales propias, sin joins ni ownership externo.
- [Registro DEC-F](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/master/arquitectura/decisiones/REGISTRO_DEC_F.md), [trazabilidad](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/master/arquitectura/decisiones/MATRIZ_TRAZABILIDAD_DEC_F.md) y [matriz intermodular](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/master/integraciones/MATRIZ_INTERMODULAR_BACKEND.md): DEC-F-001 y -011 delimitan identidad y perfil físico, sin lógica funcional en #43; DEC-F-012 separa evidencia local, contrato e integración.
- OpenAPI `0.6.0-rc.1` y AsyncAPI `0.6.0-rc.2`: candidatos consultados; sin modificaciones ni implementación de sus operaciones comerciales.

`IMPLEMENTAR_AHORA`: configuración, liveness, readiness real de PostgreSQL,
logging, documentación y pruebas. La autorización expresa para `pg` y sus tipos
resolvió la dependencia de archivos compartidos. Sin bloqueos externos del #43.

Base local: `24227527c632be4f3b8de612954328904ea57de0`. La comparación remota inicial
mostró `master` 26 commits por delante de `poma`, incluidos cambios de Taxonomía y
dependencias. No se sincronizaron ramas ni se copiaron cambios ajenos.

La comprobación autenticada de solo lectura al Session Pooler pasó el 2026-10-16
(America/Lima): `/health`, `/health/live` y `/health/ready` respondieron 200 usando
el certificado CA y el archivo privado del usuario. Esto acredita únicamente la
conexión y los permisos comprobados por readiness; no acredita CRUD del #44,
integración comercial, homologación externa ni despliegue. La publicación del
cambio se realiza desde `poma` hacia `master`; el cierre del issue queda pendiente
de revisión, aceptación y fusión del PR.

También se verificó el camino de fallo con el driver real apuntando a un puerto
local inaccesible: `/health/ready` respondió 503 y `/health/live` siguió en 200.

## Validación local ejecutada

Entorno: Node `v24.16.0`, npm `11.13.0`; tests automatizados con fixtures locales.
La comprobación de lectura real descrita arriba se ejecutó por separado.

| Comando | Resultado |
| --- | --- |
| `npm ci --ignore-scripts --no-audit --no-fund` | PASS al reintentar fuera del sandbox; primer intento terminó con `Exit handler never called`. |
| `npm install pg --save-exact --ignore-scripts --no-audit --no-fund` | PASS, dependencia autorizada. |
| `npm install --save-dev --save-exact @types/pg --ignore-scripts --no-audit --no-fund` | PASS, tipos autorizados. |
| `npm test -- apps/catalog-svc` | PASS: 59 pruebas en 6 archivos. |
| `npm run test:e2e -- apps/catalog-svc` | PASS: 3 pruebas. |
| `npm run build:catalog-svc` | PASS. |
| `npm test` | PASS: 67 pruebas en 14 archivos. |
| `npm run test:e2e` | PASS: 11 pruebas en 9 archivos. |
| `npm run typecheck` | PASS. |
| `npm run lint` | PASS sin advertencias tras corregir un escape innecesario. |
| `npm run format:check` | PASS. |
| `git diff --check` | PASS. |

Los primeros intentos de Vitest en sandbox fallaron con `EPERM` al renombrar la
caché temporal, antes de ejecutar pruebas. Las ejecuciones posteriores fuera del
sandbox pasaron. El aviso de Vite sobre `vite-tsconfig-paths` es preexistente y no
se modificó la configuración compartida.
