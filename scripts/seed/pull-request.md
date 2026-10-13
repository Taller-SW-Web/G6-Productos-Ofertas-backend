Se habilitan seis cuentas PostgreSQL individuales para que los integrantes carguen datos únicamente en sus schemas, y las pruebas del ejecutor de seeds pasan a ejecutarse en cada PR. Refs #1. No hacer merge hasta completar entrega privada y revisiones.

## Cambios

- GitHub Actions ejecuta `node --test scripts/seed/run.test.mjs`: las ocho pruebas originales más seis regresiones, sin credenciales ni conexión a Supabase.
- `parseArgs` rechaza cualquier opción repetida, incluido `--mode`.
- Una cuenta por integrante; Vera puede seleccionar pricing/price_audit y Castilla combos/bulk. El guard permite solo las membresías declaradas, sin ADMIN/INHERIT, y cada ejecución usa SET LOCAL ROLE del schema seleccionado.
- `--check-access` verifica autenticación, SSL cliente y permisos con ROLLBACK sin inventar seeds ni insertar datos.
- Procedimiento incremental de logins/grants y helper administrativo de contraseñas por psql \\password. Contraseñas diferentes, stdin privado, archivo protegido fuera de Git y ningún secreto en argumentos, SQL versionado, evidencias o logs.
- Evidencias actualizadas: el PR #5 existe; seis accesos individuales reales, ocho schemas y Session pooler verificados.

## Accesos operativos

| Integrante | Login | Schemas | psql / SSL / permisos |
| --- | --- | --- | --- |
| Axel | seed_cueva | promotions | PASS |
| López | seed_lopez | taxonomy | PASS |
| Poma | seed_poma | catalog | PASS |
| Taco | seed_taco | inventory | PASS |
| Vera | seed_vera | pricing, price_audit | PASS en ambos |
| Castilla | seed_castilla | combos, bulk | PASS en ambos |

Usuarios del pooler con sufijo del proyecto slzglmtiyrzygpkiuthf. Seis passwords iniciales ya asignados; Axel confirmó ser administrador y realizará la entrega por WhatsApp privado individual, solicitando cambio al recibirlos. Entrega/recepción todavía no acreditadas.

Grupos sin CREATE, UPDATE, DELETE ni TRUNCATE. SELECT/INSERT en 60 tablas existentes propias, excluyendo ledger/inbox/outbox/recibos; cinco helpers invoker para CHECK/triggers. Cero membresías ajenas y cero accesos efectivos entre schemas de grupos. No se comparten owners/runtime ni credenciales administrativas.

## Validación

- `node --test scripts/seed/run.test.mjs`: PASS, 14 tests.
- `npm test`: PASS, 9 tests; `npm run test:e2e`: PASS, 9 tests.
- Typecheck, lint, format:check, build:all, oxlint del ejecutor y revisión de diff: PASS.
- psql PostgreSQL 17.11: seis conexiones individuales con SSL verify-full; ocho transacciones check-access con ROLLBACK. Promociones ejecutó el seed aprobado dos veces con ROLLBACK.
- Postcheck Supabase: cero filas fixture y mismo hash de datos/estructura. Ninguna escritura de prueba fuera del contexto propio.
- Migración de accesos aplicada: `20261013171410 infra_001_individual_seed_logins`. Los dos SQL previos se conservan sin editar. No se cambian tablas/owners ni migraciones de negocio.

## Gobernanza y pendientes

AGENTS.md leído; rama permanente cueva; issue actualizado autoriza .github y scripts transversales. No se modificó ningún microservicio, dependencia global ni contrato HTTP/eventos. No se generaron seeds de negocio de otros owners.

La ejecución remota de Actions se verificará con el commit publicado; PASS local no se presenta como PASS remoto. Pendientes: entrega WhatsApp por Axel, cambio de contraseña por los destinatarios, revisión del dataset por owners y revisión técnica de Leonardo López/integración de Marco Castilla. Los 23 avisos de search_path y 5 dependencias dev con avisos son preexistentes y quedan documentados aparte. No se realizó merge.
