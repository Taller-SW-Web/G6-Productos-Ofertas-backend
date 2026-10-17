# catalog-svc — configuración y readiness (#43)

Rama personal `poma`. El PR #119 conserva el código comercial incorporado desde
master; estas correcciones se limitan a configuración, arranque, observabilidad,
readiness y sus pruebas. Las ediciones propias no cambian CI, contratos, otros servicios ni migraciones.
La integraci�n solicitada de master conserva tambi�n los cambios ajenos tal como
fueron publicados por sus owners.

## Contrato de configuración

El servicio usa exclusivamente el esquema PG. `CatalogConfig` llama al mismo
validador que el proveedor `Database` y le inyecta una instantánea de configuración:
el pool y la verificación de identidad no vuelven a leer variables distintas.
`DATABASE_URL` no sustituye este contrato y no es un modo de conexión soportado.

| Variable | Requisito y descripción |
| --- | --- |
| `NODE_ENV` | Obligatoria: `development`, `test` o `production`. |
| `CATALOG_SVC_PORT` | Puerto HTTP decimal entre 1 y 65535. |
| `PORT` | Alternativa solo cuando `CATALOG_SVC_PORT` no existe. Un valor específico inválido no usa fallback. |
| `CATALOG_SVC_HOST` | Opcional; `127.0.0.1` por defecto. Admite también `0.0.0.0`, `::1` y `::`. |
| `PGHOST` | Obligatoria; identidad DNS/IP del servidor, utilizada para verificar el certificado TLS. |
| `G6_CONNECT_HOST` | Dirección TCP opcional. Permite conectar a otro host/IP conservando la verificación TLS contra `PGHOST`. |
| `PGPORT` | Obligatoria; puerto PostgreSQL decimal entre 1 y 65535. |
| `PGDATABASE` | Obligatoria; base esperada durante la comprobación de identidad. |
| `PGUSER` | Obligatoria; identidad propia de Catálogo. En Session Pooler puede incluir el sufijo del proyecto. En modo directo debe coincidir con `G6_EXPECTED_ROLE`. |
| `PGPASSWORD` | Obligatoria; contraseña privada de esa identidad. Nunca se registra. |
| `PGSSLMODE` | Obligatoria: `verify-full`. No se permite desactivar TLS ni la validación del certificado. |
| `PGSSLROOTCERT` | Obligatoria; ruta absoluta a una CA PEM existente y legible. |
| `G6_DATABASE_SCHEMA` | Obligatoria: `catalog`. |
| `G6_EXPECTED_ROLE` | Obligatoria: `catalog_dev_login` o `catalog_app`; debe corresponder a `PGUSER`. |
| `G6_CONNECTION_MODE` | Obligatoria: `session` o `direct`. Ambos modos mantienen TLS estricto y verificación de identidad. |
| `CATALOG_TAXONOMY_URL` | Origen HTTP(S) del servicio de Taxonomía para las consultas comerciales. Si se proporciona, se valida antes del arranque: sin credenciales, path adicional, query ni fragmento. Su ausencia no habilita una integración ficticia; las operaciones dependientes fallan cerradas. |

Desde la raíz se carga `apps/catalog-svc/.env.local` y después `.env`, sin
sobrescribir valores ya definidos. Prioridad: entorno del proceso > archivo del
servicio > archivo raíz. El archivo privado del servicio está ignorado por Git.
Nunca versionar contraseñas ni rutas privadas de otros equipos.

Una configuración ausente/malformada impide crear Nest. Antes de escuchar, el
servicio comprueba identidad, base, USAGE del schema y ausencia de privilegios
administrativos/owner. Los errores de validación contienen nombres de variables,
no sus valores. Bootstrap registra JSON sanitizado con `APPLICATION_STARTED` o
`APPLICATION_START_FAILED`; el fallo sale por stderr y termina con código 1.

## Health, readiness y ciclo de vida

- `GET /health` conserva `{ "status": "ok", "service": "catalog-svc" }`.
- `GET /health/live` confirma que el proceso HTTP está vivo; no consulta la base.
- `GET /health/ready` reutiliza el mismo proveedor `Database`, configuración y pool
  de las operaciones comerciales. Verifica identidad y conserva la comprobación
  comercial de master. No abre un cliente PostgreSQL adicional.
- El endpoint ready tiene un timeout de 2 s. Un error o dependencia no comprobada
  devuelve 503 con el código contractual `SERVICIO_NO_DISPONIBLE`, sin secretos.
- Con la política comercial pendiente de master, una conexión DB válida no basta
  para declarar el servicio ready. No se sustituye esa política por mocks.
- El pool conserva su máximo de 4 conexiones y timeouts explícitos de 10 s. Los
  timeouts del pool no alargan el límite de respuesta HTTP de readiness.
- `Database` vuelve a consultar identidad en cada sondeo; no reutiliza un éxito
  anterior como evidencia de disponibilidad. Al cerrar Nest se cierra su pool.
- El sondeo CLI existente sigue en `node dist/apps/catalog-svc/readiness.js` y no
  se ejecuta al importar el controlador desde Nest o tests.

Los logs JSON redactan secretos por clave, URLs, Bearer/JWT, objetos Error y los
valores sensibles del entorno. Las requests generan o preservan correlación.
No se comprueban brokers ni se hace fan-out a servicios ajenos al trabajo admitido.

## Ejecución y pruebas

Desde la raíz, con configuración PG propia suministrada de forma segura:

```sh
npm ci
npm run build:catalog-svc
npm run start:catalog-svc
npm test -- apps/catalog-svc
npm run test:e2e -- apps/catalog-svc
npm test
npm run test:e2e
npm run build:all
npm run typecheck
npm run lint
npm run format:check
git diff --check
```

Las unitarias usan fixtures aislados para las invariantes de validación,
identidad, pool compartido, sanitización y timeout. No acreditan integración real.

`test/runtime-postgres.e2e-spec.ts` ejecuta el entry point compilado con PostgreSQL
17 descartable y TLS real cuando Docker está disponible. Comprueba arranque
positivo en `session` y `direct`, rechazo de identidad faltante, CA ajena y hostname
incorrecto, y liveness 200/readiness cerrado al detener la base. No sustituye
Database, el cliente PG ni la política comercial. Requiere Docker y OpenSSL; en
este equipo sin Docker se informa como omitida, no como PASS de integración.
En GitHub Actions Docker está disponible y la suite se ejecuta normalmente.

El workflow compartido mantiene además su prueba independiente Marketplace con
PostgreSQL, TLS, JWT, indisponibilidad y recuperación. No se modifica ni se omite
para aprobar este PR. El SHA, enlace al run y resultados reales se registran en
la descripción del PR #119 después de completar CI. No inferir despliegue,
homologación externa ni aceptación de otros módulos a partir de esos resultados.

## Fuentes

- [Issue #43](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/43).
- [Arquitectura §§7, 23–25](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/master/arquitectura/Arquitectura.md).
- [Guía PG del proyecto](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/ops/postgres-runtime/guia-desarrollo-local.md).
- DEC-F-001 y -011 delimitan identidad y perfil físico; DEC-F-012 exige distinguir
  contrato, implementación local, integración autenticada y despliegue.
