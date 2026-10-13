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

La configuración versionada permite exclusivamente `shared`, proyecto `slzglmtiyrzygpkiuthf`, base `postgres`, host directo comprobado y puerto 5432. **Shared es solo para verificación con ROLLBACK**; no se presume que sea un entorno productivo ni se permiten cargas permanentes en él. Un owner revisa cualquier nueva entrada de entorno y autorización de carga persistente en `registry.json`; nunca basta cambiar una variable local.

Copiar host, puerto y usuario desde **Connect** de Supabase. Si se necesita IPv4, registrar la conexión del pooler **session** real del panel mediante revisión del registry; el pooler transaction no está autorizado. No inferir un hostname ni usar el usuario postgres del pooler. Reglas de [conexión PostgreSQL](https://supabase.com/docs/guides/database/connecting-to-postgres) y [SSL](https://supabase.com/docs/guides/database/connecting-to-postgres#ssl-connections).

Variables de proceso, sin imprimirlas: `SEED_ENVIRONMENT`, `SEED_PROJECT_REF`, `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` o `PGPASSFILE`, `PGSSLMODE=verify-full` y `PGSSLROOTCERT`. Usar el CA descargado del panel y un archivo de contraseñas protegido fuera de Git, o el gestor de secretos del entorno. `scripts/seed/.env.example` es una plantilla: el ejecutor no carga automáticamente archivos .env.

`PGOPTIONS`, `PGSERVICE`, URLs y otras variables que puedan redirigir libpq no se reenvían al subproceso. `psql -X -w` evita scripts de inicio y prompts. El login real se comprueba en la base: sin atributos administrativos, ownership de schemas ni membresías de otros roles. Los errores raw de libpq/SQL se capturan y se reporta un código estable, sin devolver valores de fixtures ni credenciales. No activar echo SQL ni logs de variables.

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

Los grupos quedan sin privilegios administrativos, sin membresía de owners/runtime y con USAGE solo de su schema. No tienen CREATE, DELETE, UPDATE, permisos de secuencias ni nuevos grants de EXECUTE de funciones de negocio. Solo Promociones tiene SELECT/INSERT de seis columnas de `stock_projection`; los otros grupos no tienen permisos de tabla hasta que su owner registre un seed revisado. No se concedió nada a PUBLIC, anon ni authenticated ni se alteró la exposición Data API/RLS.

Para entregar acceso al responsable, el administrador crea un login individual limitado; ejemplo revisable para Axel:

```sql
CREATE ROLE seed_promotions LOGIN NOINHERIT NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT po_promotions_seed TO seed_promotions WITH INHERIT FALSE, SET TRUE;
```

La contraseña se establece fuera de SQL versionado y fuera de logs (`\password seed_promotions` en una sesión administrativa individual protegida). El usuario del pooler se copia del panel con su sufijo exacto. No compartir ese login con servicios ni dar al owner una contraseña de postgres. Comprobar membresías, privilegios de schema/columnas y atributos con consultas de catálogo antes de entregar el acceso. Nunca usar `GRANT ..._owner` para resolver un error del seed.

Los cambios persistentes de permisos y el alta de logins requieren el administrador autorizado. Consultar evidencia para distinguir los grupos aplicados de los logins individuales, que todavía no se han entregado. El provisionamiento no recrea tablas ni duplica migraciones del repositorio oficial. En un entorno nuevo, aplicar el procedimiento completo de accesos dentro de transacciones revisadas; `SET LOCAL ROLE` requiere una transacción.

## Estructura y aprobación por owner

`required/<schema>/` reserva configuraciones obligatorias, `demo/<schema>/` pruebas/demostraciones. Un directorio vacío falla con `NO_APPROVED_SEEDS`; no es una carga exitosa. No se inventan valores obligatorios de negocio. Únicamente se incluye un fixture reversible de Promociones; poblar los otros contextos sigue a cargo de sus owners.

Los scripts son JSON declarativos `NNN_nombre.json`, con `version`, `schema`, `kind`, `description` e `inserts` (`table` y `rows`). No se ejecuta SQL proporcionado por un fixture. `registry.json` define tablas, columnas y clave idempotente permitidas según el modelo físico y restricciones desplegadas. Dinero/decimales y bigint se representan como strings para evitar redondeos de JavaScript. Las claves son identidades estables respaldadas por UNIQUE/PK; las referencias externas nunca provocan FK ni consultas a otro schema.

Al registrar un nuevo seed, el owner comprueba modelo/migraciones vigentes, completa la allowlist y solicita exclusivamente los grants de columnas necesarios. Las filas no pueden modificar ni borrar registros existentes: `ON CONFLICT(key) DO NOTHING` seguido de una comparación de contenido. Un mismo ID con contenido diferente falla `SEED_CONTENT_CONFLICT` y revierte toda la carga. Las demás constraints se verifican antes del fin de la transacción. Esto preserva datos comerciales existentes y hace seguros los reintentos concurrentes.

`dataset.json` reserva identidades de demo y el orden **Taxonomía → Catálogo → Pricing → Inventario**. Es un manifiesto de fixtures, no un nuevo DTO público, mapeo logístico ni una integración autenticada. `PEN` y los SKU elegidos son valores de demostración, no nuevas restricciones contractuales. Los owners deben revisar las identidades y definir sus cargas antes de usar el dataset como integración. El fixture de stock de Promociones se marca no autoritativo y solo se utiliza con rollback; no sustituye la integración real de Inventario en producción.

## Comandos

```powershell
node --test scripts/seed/run.test.mjs
node scripts/seed/run.mjs --schema promotions --environment shared --kind demo --render-sql
node scripts/seed/run.mjs --schema promotions --environment shared --kind demo
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
