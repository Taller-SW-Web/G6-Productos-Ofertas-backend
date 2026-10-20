# taxonomy-svc

Microservicio de taxonomía (categorías y marcas) del backend G6.

## Variables de entorno

El servicio valida la configuración en el arranque y falla cerrado (`fail-closed`): si falta o es inválida alguna variable requerida, no inicia. Nunca imprimir ni registrar valores reales; las credenciales se enmascaran en los logs.

| Nombre              | Descripción                                                                                            | Requerido     | Valor por defecto |
| ------------------- | ------------------------------------------------------------------------------------------------------ | ------------- | ----------------- |
| `NODE_ENV`          | Entorno de ejecución. Debe ser uno de `development`, `test`, `production`.                             | Sí            | Ninguno           |
| `TAXONOMY_SVC_PORT` | Puerto HTTP del servicio. Entero entre 1 y 65535.                                                      | Sí (o `PORT`) | Ninguno           |
| `PORT`              | Puerto HTTP alternativo; se usa solo si no se define `TAXONOMY_SVC_PORT`.                              | No            | Ninguno           |
| `DATABASE_URL`      | URL de conexión PostgreSQL a la taxonomía (`postgresql://` o `postgres://`), con host y base de datos. | Sí            | Ninguno           |

## Endpoints operativos

- `GET /health`: liveness estático; responde `200` sin consultar dependencias.
- `GET /health/readiness`: readiness; verifica acceso de lectura real con dos consultas Drizzle ORM independientes (sin concatenar SQL), cada una con `WHERE estado = 'ACTIVO' LIMIT 1`:
  - `taxonomy.categories`: selecciona `id`, `nombre`, `categoria_padre_id`, `orden`, `estado`. `orden` se incluye porque la lectura comercial productiva lo usa en `ORDER BY`.
  - `taxonomy.brands`: selecciona `id`, `nombre`, `descripcion`, `pais_origen_iso`, `logo_url`, `estado`.

  Responde `200` solo si ambas consultas resuelven, o `503` (problem+json, `SERVICIO_NO_DISPONIBLE`) ante cualquier error: conexión fallida, permisos denegados (`42501`) sobre las columnas consultadas —incluidas `categories.orden` y `brands.logo_url`—, o tabla/columna ausente.

## Persistencia

- Driver `drizzle-orm` sobre `pg` (`node-postgres`).
- Esquema en `src/persistence/taxonomy.schema.ts`: mapea las doce tablas del modelo físico bajo `taxonomy` (`runtime_settings`, `categories`, `brands`, `characteristics`, `characteristic_values`, `product_types`, `product_type_characteristics`, `category_seo`, `slug_history`, `master_deactivation_operations`, `outbox`, `inbox`), con enums locales, relaciones y restricciones declaradas.
- El arranque no crea ni modifica tablas. Las migraciones se administran por el proceso autorizado del bounded context; no usar `drizzle-kit push` ni reescribir migraciones existentes.
- `DrizzleTaxonomyRepository` implementa `TaxonomyRepository` y `TaxonomyReadinessIndicator`; las lecturas filtran por `estado = 'ACTIVO'`.
- Con `DATABASE_URL` definida el módulo usa el repositorio Drizzle; sin ella usa `UnconfiguredTaxonomyRepository` (responde `503`). Los fallos de conexión se traducen a `503 SERVICIO_NO_DISPONIBLE`; el resto se propaga y el filtro lo sanitiza como `500 ERROR_INTERNO`.
- Las escrituras se agrupan con `enTransaccion` (commit/rollback) y el pool se cierra al apagar la aplicación (`onApplicationShutdown`).

## Pruebas de integración (Postgres aislado)

`scripts/ci/run-taxonomy-integration.mjs` aprovisiona y elimina su propio contenedor `postgres:17-alpine`, publica el puerto solo en loopback y genera la URL/credenciales internamente. Rechaza `TAXONOMY_TEST_DATABASE_URL` recibida desde el entorno. PostgreSQL se inicia con un identificador aleatorio de sesión que el preflight coteja mediante `current_setting()` antes de permitir cualquier DDL; un testigo insertado en una URL recibida no se considera acreditación. No apuntar pruebas destructivas a Supabase ni a bases compartidas.

```sh
node scripts/ci/run-taxonomy-integration.mjs
```

La suite crea esquema, roles y datos de prueba únicamente en el contenedor gestionado por el runner, verifica permisos efectivos (positivos y negativos), transacciones (commit/rollback), readiness y el camino `503`, y elimina contenedor y esquema al finalizar.

## Integración Marketplace H4 — Taxonomy

**Corte:** rama `lopez`, HEAD auditado `4e099f5c04d7ba17a100b669c6a85f4eae6f90ec`; PR #131 abierto. CI Actions del SHA exacto consultada 2026-10-20: PASS (lint/typecheck/test/build/smoke y PostgreSQL Taxonomy desechable). PR #131 se limita principalmente a persistencia y no afirma crear nuevos endpoints en ese diff; los handlers indicados ya se observan en el código de la rama actual. No se infiere grant, deploy ni BFF/E2E G1.

| OperationId G6 | Método/ruta | Dependencia Marketplace |
|---|---|---|
| `listarCategorias` | GET `/api/v1/categorias` | Categorías activas/comerciales para navegación y taxonomía de catálogo (F-006/F-007/F-008 según consumidor). |
| `listarMarcas` | GET `/api/v1/marcas` | Marcas para ficha y facetas BFF; Marketplace no obtiene marca vía acceso a BD G6. |

Los handlers devuelven wrappers contractuales `categories`/`brands`, rechazan filtros/paginación no soportados y validan `X-Correlation-Id` cuando se envía. La implementación actual filtra catálogo por estado mediante repositorio; Provider debe validar categorías/marcas activas, `[]` válido, errores upstream y campos comerciales, contra PostgreSQL aislado del SHA. No declarar filtrado comercial o BFF real solo por pruebas de controller.

G1 integra mediante BFF y Gateway G6; audience `api-productos`, cliente/scopes/allowlist se contrastan por OpenAPI. No se debe llamar directamente al servicio desde navegador Marketplace. La cobertura por DB aislada de CI del SHA `4e099f5` no demuestra datos de Supabase, deploy Oracle, grant G7 o E2E. Ver [matriz H4](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/blob/castilla/integraciones/g1-marketplace/MATRIZ_OPERACIONES_H4.md) y [acuerdo normativo](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/docs/g1-marketplace-homologacion-lote03/integraciones/ACUERDO_G1_G6_H4_2026-10-20.md).
