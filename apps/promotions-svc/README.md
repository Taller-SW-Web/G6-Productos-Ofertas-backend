# Promotions: estructura y configuración — backend #70

Owner: Axel Cueva. Rama: `cueva`. Alcance: `apps/promotions-svc/`.
No se modifican otras aplicaciones, dependencias/configuración global, contratos,
migraciones históricas, permisos ni datos compartidos.

## Base normativa consultada

Docs: commit `c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b`.

- `arquitectura/Arquitectura.md`: capas/ownership (§2, §4, §7), configuración
  tipada y validación al arrancar (§23), logging (§24), health/readiness (§25),
  shutdown (§45) y timeouts (§47).
- `contratos/http/openapi.yaml`: candidata `0.6.0-rc.1`.
- `contratos/eventos/asyncapi.yaml`: candidata `0.6.0-rc.2`.
- Registro DEC-F, matriz de trazabilidad y matriz intermodular: DEC-F-007/008/009
  delimitan las reglas futuras de Promotions, sin implementarlas en #70;
  DEC-F-012 exige separar contrato, implementación, pruebas e integración.
- SPEC-005/006/007 y `datos/promotions/physical-model.md`: ownership propio,
  proyecciones no autoritativas y dependencias de PostgreSQL/mensajería.
- `ops/postgres-runtime/guia-desarrollo-local.md`: variables y archivo local del
  servicio, identidad propia, Session Pooler y SSL verify-full.

El issue cita también `datos/promotions-svc/physical-model.md`, que no existe en
el árbol consultado. La ruta canónica existente es `datos/promotions/physical-model.md`.

## Carga y validación

Plantilla: `.env.example` de esta aplicación. Copiarla como `.env.local` en la
misma carpeta y completar `PGPASSWORD`, `PGSSLROOTCERT` y `RABBITMQ_URL` con los
valores privados/autorizados. Host, puerto, base, login, schema y modo provienen
de la sección 2 de la guía oficial. El certificado debe ser el de tu equipo;
no copiar la ruta de otro integrante. El archivo local queda ignorado por Git.
La guía PostgreSQL no entrega la configuración RabbitMQ; ese campo es separado
y no se rellena con un broker ficticio. Con un campo obligatorio vacío el
servicio informa su nombre y rechaza el arranque.

Desde la raíz del backend, `npm run start:dev:promotions-svc` o, después del build,
`npm run start:promotions-svc`. La aplicación carga `.env` y después
`apps/promotions-svc/.env.local`; las variables de la sesión tienen precedencia
sobre ambos archivos. No modifica `process.env` ni carga `.env.local` de otros
servicios o el archivo administrativo de la raíz. Los errores de lectura no
publican rutas ni contenidos.

Guardar los valores privados en el archivo local ya ignorado por Git. Recibir
la identidad y contraseña runtime por el canal designado; no usar una cuenta
seed, owner o administrativa. La validación de configuración no demuestra los
permisos efectivos del login: eso corresponde a la prueba de persistencia #71.

| Variable            | Requisito / propósito                                                                 |
| ------------------- | ------------------------------------------------------------------------------------- |
| NODE_ENV            | development, test o production; por defecto development. No autoriza despliegue.      |
| PROMOTIONS_SVC_PORT | Puerto HTTP entero 1–65535. Tiene precedencia sobre PORT.                             |
| PORT                | Fallback HTTP; si faltan ambos puertos se conserva 3004.                              |
| PGHOST              | Host PostgreSQL sin URI, credenciales ni espacios. Obligatorio.                       |
| PGPORT              | Puerto PostgreSQL entero 1–65535. Obligatorio.                                        |
| PGDATABASE          | Nombre de la base autorizada. Obligatorio.                                            |
| PGUSER              | Login runtime propio de Promotions según la guía oficial. Obligatorio.                |
| PGPASSWORD          | Contraseña privada del login. Obligatoria, nunca se registra.                         |
| PGSSLMODE           | Obligatorio: verify-full; no hay downgrade TLS.                                       |
| PGSSLROOTCERT       | Ruta absoluta legible a un archivo X.509 válido del CA autorizado. Obligatoria.       |
| G6_DATABASE_SCHEMA  | Obligatorio: promotions.                                                              |
| G6_CONNECTION_MODE  | Obligatorio: session.                                                                 |
| RABBITMQ_URL        | URI AMQP/AMQPS del destino autorizado, sin query ni fragmento. Obligatoria y privada. |

La ausencia o invalidez de variables obligatorias impide crear la aplicación y
abrir su puerto. El diagnóstico contiene únicamente nombres de variables.
El logger de arranque emite JSON con timestamp, nivel, servicio y código fijo;
no serializa excepciones raw, stacks, URLs, contraseñas ni tokens. Se desactiva
el logger raw de Nest durante bootstrap. Los logs operativos de negocio son
alcance posterior de #76.

Validar el archivo CA no prueba la identidad del servidor ni una sesión TLS:
la conexión real con verify-full y el rol efectivo se comprobarán en #71.
No se crean conexiones PostgreSQL o RabbitMQ en este bloque.

## Liveness y readiness

`GET /health` conserva su payload y confirma solamente que el proceso vive.
No indica conexión DB/broker, disponibilidad funcional ni integración externa.

`PromotionsReadinessService.check()` comprueba únicamente probes de PostgreSQL y
broker propios, con timeout de 1 segundo y señal de cancelación por probe. Sin
adaptador real devuelve `not_implemented` y resultado global `not_ready`.
Un error/timeout devuelve `down` sin el diagnóstico raw; solo ambas comprobaciones
exitosas en esa invocación permiten `ready`. No hay fan-out a otros servicios.

Los adaptadores autenticados pertenecen a #71 (DB) y #75 (broker). No se sustituyen
por pings TCP, arrays o éxito simulado. Los dobles existen solo en pruebas.

## Exposición HTTP fuera del alcance de #70

Arquitectura §25 pide `/health/live` y `/health/ready`, pero los criterios de #70
dicen **«No se agregan rutas o reglas de negocio»**. OpenAPI no declara rutas de
health. Por esa contradicción se conserva únicamente `/health` y se prueba la
readiness internamente, sin ampliar el contrato HTTP.

Se sigue el criterio explícito de #70: no agregar rutas. La tarea de #76 ya
incluye exponer health/readiness seguro, por lo que esa exposición se mantiene
en el bloque posterior y debe aplicar las rutas técnicas de arquitectura una
vez satisfechos sus prerrequisitos. Esta separación de fases permite terminar
la configuración y evaluación interna de #70 sin inventar endpoints ahora.

Estado de #70: configuración, logging y evaluación interna implementados y
probados. Sondas autenticadas y exposición HTTP de readiness pertenecen a los
bloques posteriores; homologación y despliegue no se acreditan. El cierre formal
requiere revisión y PR fusionado. La configuración privada todavía debe completar
RABBITMQ_URL para arrancar con ese archivo; no se rellena con un broker ficticio.

## Verificación

Pruebas enfocadas antes de generales:

```powershell
npm test -- apps/promotions-svc --maxWorkers=1
npm run test:e2e -- apps/promotions-svc --maxWorkers=1
```

Cubren configuración incompleta/malformada, precedencia de archivos/sesión,
certificado inválido, bootstrap por el provider real, errores sin secretos,
liveness independiente, readiness sin adaptadores, caída/recuperación y timeout.
No acreditan integración autenticada ni E2E de negocio.

Resultado real del 2026-10-16 (America/Lima), Node v24.21.0 / npm 11.19.0:

| Comando                                                  | Resultado                                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `npm test -- apps/promotions-svc --maxWorkers=1`         | PASS: 4 archivos, 43 tests.                                                                |
| `npm run test:e2e -- apps/promotions-svc --maxWorkers=1` | PASS: 1 archivo, 4 tests.                                                                  |
| `npm test -- --maxWorkers=1`                             | PASS: 12 archivos, 51 tests.                                                               |
| `npm run test:e2e -- --maxWorkers=1`                     | PASS: 9 archivos, 12 tests.                                                                |
| `npm run typecheck`                                      | PASS.                                                                                      |
| `npm run lint`                                           | PASS.                                                                                      |
| `npm run format:check`                                   | PASS.                                                                                      |
| `npm run build:promotions-svc`                           | PASS.                                                                                      |
| `node apps/promotions-svc/test/startup.smoke.mjs`        | PASS: arranque compilado inválido rechazado, liveness HTTP y logs sin secretos sintéticos. |
| `node --test scripts/seed/run.test.mjs`                  | PASS: 14 tests, revisión independiente de #1.                                              |

El primer intento de Vitest en sandbox falló con EPERM al renombrar temporales;
las ejecuciones fuera de esa restricción pasaron. El smoke compilado tampoco
alcanzó su puerto loopback dentro del sandbox; fuera de esa restricción pasó.
No se modificaron tests/configuración global para evitar esas restricciones.
Vitest informa un aviso de deprecación del plugin existente vite-tsconfig-paths;
no se cambian dependencias o configuración compartida por este issue.

Estos resultados históricos son del bloque #70, anteriores a los nuevos tests
de #33. Ver `COUPON_COMMANDS.md` y `test/evidence/` para las pruebas posteriores
de cupones. El PR #116 conserva el alcance Gateway; estos cambios aún son locales.
