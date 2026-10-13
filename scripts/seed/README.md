# Seeds seguros — issue backend #1

Responsable: Axel Cueva (`cueva`). Revisión BD: Leonardo López. Integración: Marco Castilla.
Estado operativo: `IMPLEMENTAR_PARCIAL`; ver [evidencias](evidence.md) para distinguir implementación, prueba real y provisión pendiente.

## Fuentes normativas

- [Issue #1](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/1) autoriza herramientas transversales y configuración de seeds; no autoriza poblar datos de otro owner.
- [Arquitectura §7–8](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/master/arquitectura/Arquitectura.md), [convenciones BD](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/master/datos/CONVENCIONES_BD.md) y [despliegue](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/master/datos/deploy/README.md).
- [Registro DEC-F](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/942bf7322eb388fe5b0fcc9c5a565152e1099139/arquitectura/decisiones/REGISTRO_DEC_F.md), [trazabilidad](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/942bf7322eb388fe5b0fcc9c5a565152e1099139/arquitectura/decisiones/MATRIZ_TRAZABILIDAD_DEC_F.md) y [matriz intermodular](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/942bf7322eb388fe5b0fcc9c5a565152e1099139/integraciones/MATRIZ_INTERMODULAR_BACKEND.md).

Aplican DEC-F-001 (producto/variante/SKU distintos), -002 (Inventario autoritativo), -006 (Pricing autoritativo), -007 (proyecciones de Promociones no transfieren ownership), -009 (repetición equivalente sin efectos, contenido distinto rechazado) y -012 (fuentes, historia inmutable y estados separados). No se modifican contratos HTTP/eventos ni se implementan handlers comerciales.

## Requisitos y destino

Node compatible con el monorepo y cliente `psql` PostgreSQL 17. El ejecutor usa módulos nativos de Node; no instala dependencias ni necesita claves anon/service_role, tokens MCP ni contraseñas administrativas. Confirmar `node --version` y `psql --version`.

La configuración versionada permite exclusivamente `shared`, proyecto `slzglmtiyrzygpkiuthf`, base `postgres`, conexión directa o Session pooler `aws-0-sa-east-1.pooler.supabase.com`, puerto 5432. El pooler fue copiado de Connect por el administrador y verificado con psql. **Shared es solo para verificación con ROLLBACK**; no se presume que sea un entorno productivo ni se permiten cargas permanentes en él. Un owner revisa cualquier nueva entrada de entorno y autorización de carga persistente en `registry.json`; nunca basta cambiar una variable local.

Copiar host, puerto y usuario desde **Connect** de Supabase. Si se necesita IPv4, registrar la conexión del pooler **session** real del panel mediante revisión del registry; el pooler transaction no está autorizado. No inferir un hostname ni usar el usuario postgres del pooler. Reglas de [conexión PostgreSQL](https://supabase.com/docs/guides/database/connecting-to-postgres) y [SSL](https://supabase.com/docs/guides/database/connecting-to-postgres#ssl-connections).

Variables de proceso, sin imprimirlas: `SEED_ENVIRONMENT`, `SEED_PROJECT_REF`, `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` o `PGPASSFILE`, `PGSSLMODE=verify-full` y `PGSSLROOTCERT`. Usar el CA descargado del panel y un archivo de contraseñas protegido fuera de Git, o el gestor de secretos del entorno. `scripts/seed/.env.example` es una plantilla: el ejecutor no carga automáticamente archivos .env.

`PGOPTIONS`, `PGSERVICE`, URLs y otras variables que puedan redirigir libpq no se reenvían al subproceso. `psql -X -w` evita scripts de inicio y prompts. El login real se comprueba en la base: sin atributos administrativos, ownership de schemas/base ni membresías fuera de su asignación explícita. Los errores raw de libpq/SQL se capturan y se reporta un código estable, sin devolver valores de fixtures ni credenciales. No activar echo SQL ni logs de variables. `\conninfo` confirma SSL del cliente; `pg_stat_ssl` detrás del pooler describe el tramo interno y no se usa como prueba del TLS de psql.

## Accesos y responsables

| Schema | Responsable / rama | Grupo de carga |
| --- | --- | --- |
| taxonomy | Leonardo López / lopez | po_taxonomy_seed |
| catalog | Gabriel Poma / poma | po_catalog_seed |
| pricing | Leonardo Vera / vera | po_pricing_seed |
| price_audit | Leonardo Vera / vera | po_price_audit_seed |
| promotions | Axel Cueva / cueva | po_promotions_seed |
| combos | Marco Castilla / castilla | po_combos_seed |
| inventory | Miguel Taco / taco | po_inventory_seed |
| bulk | Marco Castilla / castilla | po_bulk_seed |

El administrador individual autorizado revisa `access/provision.sql` y `access/owner-grants.sql`. El primero conserva el SQL original aplicado: creó grupos **NOLOGIN, NOINHERIT** y membresía SET ROLE de postgres, pero los grants de objetos resultaron sin efecto porque postgres tiene SET y no INHERIT de los owners. El segundo corrige esos grants con SET LOCAL ROLE explícito de cada owner y assertions; no se reescribe el historial aplicado. **Ambos ya fueron aplicados con autorización expresa en el proyecto compartido; no volver a ejecutarlos como migraciones nuevas.**

La actualización del issue autoriza cuentas individuales y permisos de carga funcionales. `access/member-logins.sql` ya fue aplicado: seis logins **LOGIN/NOINHERIT**, límite de tres conexiones, y solo membresías de los seed roles propios con **ADMIN FALSE / INHERIT FALSE / SET TRUE**. Los grupos mantienen USAGE solo de su schema y SELECT/INSERT sobre 60 tablas ya existentes de sus contextos. Se excluyen ledger `schema_migrations`, `inbox`, `outbox` y `coupon_command_receipts`; no hay UPDATE, DELETE, TRUNCATE, CREATE ni default grants sobre tablas futuras. Se conceden únicamente los helpers invoker que requieren CHECK/triggers existentes; no el archiver DEFINER ni funciones de consumo/restauración de cupón. No se alteran owners, runtime, Data API ni RLS.

| Integrante | Login PostgreSQL | Schemas permitidos | Usuario de Session pooler |
| --- | --- | --- | --- |
| Axel Cueva | seed_cueva | promotions | seed_cueva.slzglmtiyrzygpkiuthf |
| Leonardo López | seed_lopez | taxonomy | seed_lopez.slzglmtiyrzygpkiuthf |
| Gabriel Poma | seed_poma | catalog | seed_poma.slzglmtiyrzygpkiuthf |
| Miguel Taco | seed_taco | inventory | seed_taco.slzglmtiyrzygpkiuthf |
| Leonardo Vera | seed_vera | pricing, price_audit | seed_vera.slzglmtiyrzygpkiuthf |
| Marco Castilla | seed_castilla | combos, bulk | seed_castilla.slzglmtiyrzygpkiuthf |

Una cuenta por integrante permite ambos schemas de Vera/Castilla sin heredar sus privilegios. El login solo puede hacer SET ROLE de los grupos listados en `registry.accounts`; cada ejecución selecciona uno y vuelve a comprobar su aislamiento. Tener una membresía administrativa, ajena, heredable o delegable falla antes de cargar. La identidad de pooler debe llevar el sufijo exacto del proyecto. Nunca se conceden owners/runtime al integrante.

Las contraseñas iniciales diferentes ya fueron asignadas con `psql \password`, que cifra antes de enviarlas al servidor. El helper local `access/credentials.mjs` utiliza pipes privados, captura errores sin imprimir secretos y guarda la entrega en una carpeta temporal fuera de Git, con ACL solo del administrador en Windows. No usa contraseñas literales en SQL ni argumentos. El administrador autorizado es Axel; **él realizará el WhatsApp privado individual**, según su instrucción. Debe pedir a cada integrante cambiar la contraseña al recibirla usando `\password` desde su propia sesión psql. No enviar el archivo completo al grupo ni compartir credenciales administrativas.

El helper es una operación administrativa de asignación inicial, no una validación rutinaria. Reejecutarlo cambia las contraseñas de las seis cuentas; exige intención explícita:

```powershell
node --env-file=.env.local scripts/seed/access/credentials.mjs --assign-initial-passwords --psql "C:/ruta/psql.exe"
```

`.env.local` contiene únicamente la conexión del administrador y está ignorado por Git. Las credenciales resultantes nunca se incorporan a evidencias/PR/CI. Los cambios de permisos se aplican por el administrador mediante migraciones incrementales; no reejecutar los tres SQL históricos ya aplicados. Ver [evidencias](evidence.md) para los resultados por integrante y el estado de entrega.

## Estructura y aprobación por owner

`required/<schema>/` reserva configuraciones obligatorias, `demo/<schema>/` pruebas/demostraciones. Un directorio vacío falla con `NO_APPROVED_SEEDS`; no es una carga exitosa. Para comprobar el acceso sin datos usar `--check-access`, exclusivamente con verify: conecta, verifica SSL/login/rol/permisos y termina en ROLLBACK sin INSERT. No se inventan valores obligatorios de negocio. Únicamente se incluye un fixture reversible de Promociones; poblar los otros contextos sigue a cargo de sus owners.

Los scripts son JSON declarativos `NNN_nombre.json`, con `version`, `schema`, `kind`, `description` e `inserts` (`table` y `rows`). No se ejecuta SQL proporcionado por un fixture. `registry.json` define tablas, columnas y clave idempotente permitidas según el modelo físico y restricciones desplegadas. Dinero/decimales y bigint se representan como strings para evitar redondeos de JavaScript. Las claves son identidades estables respaldadas por UNIQUE/PK; las referencias externas nunca provocan FK ni consultas a otro schema.

Al registrar un nuevo seed, el owner comprueba modelo/migraciones vigentes, completa la allowlist y solicita exclusivamente los grants de columnas necesarios. Las filas no pueden modificar ni borrar registros existentes: `ON CONFLICT(key) DO NOTHING` seguido de una comparación de contenido. Un mismo ID con contenido diferente falla `SEED_CONTENT_CONFLICT` y revierte toda la carga. Las demás constraints se verifican antes del fin de la transacción. Esto preserva datos comerciales existentes y hace seguros los reintentos concurrentes.

`dataset.json` reserva identidades de demo y el orden **Taxonomía → Catálogo → Pricing → Inventario**. Es un manifiesto de fixtures, no un nuevo DTO público, mapeo logístico ni una integración autenticada. `PEN` y los SKU elegidos son valores de demostración, no nuevas restricciones contractuales. Los owners deben revisar las identidades y definir sus cargas antes de usar el dataset como integración. El fixture de stock de Promociones se marca no autoritativo y solo se utiliza con rollback; no sustituye la integración real de Inventario en producción.

## Comandos

```powershell
node --test scripts/seed/run.test.mjs
node scripts/seed/run.mjs --schema promotions --environment shared --kind demo --render-sql
node scripts/seed/run.mjs --schema promotions --environment shared --kind demo
node scripts/seed/run.mjs --schema taxonomy --environment shared --kind required --mode verify --check-access
```

Si psql no está en PATH, añadir `--psql "C:/ruta/psql.exe"`. `--render-sql` valida los fixtures y genera la transacción sin conectarse ni leer credenciales. El SQL generado permite al administrador autorizado probar el **rol restringido** desde SQL Editor/MCP con SET LOCAL ROLE; no acredita la conectividad psql del login individual. La ejecución normal añade la comprobación del login individual antes de reducir sus permisos al grupo seed.

El modo predeterminado `verify` repite toda la carga dos veces en una sola transacción, valida contenido/constraints y siempre finaliza en ROLLBACK. Se aplica un advisory lock por schema, timeout SQL de 30s, lock de 5s y conexión de 10s; cualquier error detiene psql y el cierre de sesión revierte la transacción.

Para un entorno persistente **expresamente registrado y revisado**:

```text
node scripts/seed/run.mjs --schema <schema-propio> --environment <entorno-autorizado> --kind required --mode apply
```

No existe un target apply aprobado en esta entrega. En un entorno marcado `production`, `demo` se rechaza en ambos modos. No hay ejecución automática al arrancar servicios ni al hacer deploy. El resultado normal informa schema, entorno, modo, persistencia y SHA-256 UTF-8/LF por archivo; se conservan esos hashes junto a la revisión y resultado de la carga.

## Validación y errores

Antes: comprobar owners/estructuras y obtener baseline de la tabla fixture y ledger. Durante: confirmar rol efectivo, ausencia de privilegios cross-schema, repetir fixture, validar unicidad y contenido. Después: confirmar cero filas fixture y mismos hashes/counts de datos/estructura; revisar permisos y advisors. Consultas de privilegios reemplazan intentos de escritura en schemas ajenos.

| Código | Acción |
| --- | --- |
| UNAUTHORIZED_SCHEMA / UNAUTHORIZED_ENVIRONMENT / UNAUTHORIZED_DESTINATION | Corregir selección; registrar un destino solo mediante revisión. |
| TARGET_VERIFY_ONLY / DEMO_IN_PRODUCTION | Usar verify en shared; no ejecutar demos en producción. |
| SSL_VERIFY_FULL_REQUIRED | Configurar CA real y verify-full; no desactivar SSL. |
| NO_APPROVED_SEEDS | El owner todavía debe definir la carga; no crear datos ficticios obligatorios. |
| SEED_ROLE_REQUIRED / DEDICATED_UNPRIVILEGED_LOGIN_REQUIRED | El administrador verifica login/membresía, nunca concede owner/runtime. |
| SEED_CONTENT_CONFLICT | Investigar colisión; no sobrescribir datos ni modificar semillas aplicadas silenciosamente. |
| PSQL_FAILED_CHECK_CLIENT_CONNECTION_AND_SQL | Confirmar instalación/conexión/permisos y revisar SQL generado en un canal privado; no copiar errores con secretos al PR. |

Las pruebas locales no acreditan integración autenticada, homologación ni despliegue de los microservicios. Las observaciones preexistentes fuera de ownership quedan registradas como dependencias específicas en evidencia.

El [PR #5](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/pull/5) ya existe desde cueva hacia master. La descripción está en [pull-request.md](pull-request.md). No hacer merge ni cerrar el issue hasta confirmar la entrega privada y las revisiones requeridas. GitHub Actions ejecuta `node --test scripts/seed/run.test.mjs` en cada PR dirigido a master, sin secretos ni conexión a Supabase.
