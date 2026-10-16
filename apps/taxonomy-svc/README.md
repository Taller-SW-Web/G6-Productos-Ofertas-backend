# taxonomy-svc

Microservicio de taxonomía (categorías y marcas) del backend G6.

## Variables de entorno

El servicio valida la configuración en el arranque y falla cerrado (`fail-closed`): si falta o es inválida alguna variable requerida, no inicia. Nunca imprimir ni registrar valores reales; las credenciales se enmascaran en los logs.

| Nombre | Descripción | Requerido | Valor por defecto |
|---|---|---|---|
| `NODE_ENV` | Entorno de ejecución. Debe ser uno de `development`, `test`, `production`. | Sí | Ninguno |
| `TAXONOMY_SVC_PORT` | Puerto HTTP del servicio. Entero entre 1 y 65535. | Sí (o `PORT`) | Ninguno |
| `PORT` | Puerto HTTP alternativo; se usa solo si no se define `TAXONOMY_SVC_PORT`. | No | Ninguno |
| `DATABASE_URL` | URL de conexión PostgreSQL a la taxonomía (`postgresql://` o `postgres://`), con host y base de datos. | Sí | Ninguno |

## Endpoints operativos

- `GET /health`: liveness estático; responde `200` sin consultar dependencias.
- `GET /health/readiness`: readiness; responde `200` solo cuando la fuente de datos de taxonomía está disponible, o `503` (problem+json, `SERVICIO_NO_DISPONIBLE`) en caso contrario.

## Persistencia

- Driver `drizzle-orm` sobre `pg` (`node-postgres`).
- Esquema en `src/persistence/taxonomy.schema.ts`: `taxonomy.categories` y `taxonomy.brands` mapeadas al modelo físico, incluido el enum `taxonomy.estado_entidad` y la columna generada `nombre_normalizado`.
- `DrizzleTaxonomyRepository` implementa `TaxonomyRepository` y `TaxonomyReadinessIndicator`; las lecturas filtran por `estado = 'ACTIVO'`.
- Con `DATABASE_URL` definida el módulo usa el repositorio Drizzle; sin ella usa `UnconfiguredTaxonomyRepository` (responde `503`). Los fallos de conexión se traducen a `503 SERVICIO_NO_DISPONIBLE`; el resto se propaga y el filtro lo sanitiza como `500 ERROR_INTERNO`.
- Las escrituras se agrupan con `enTransaccion` (commit/rollback) y el pool se cierra al apagar la aplicación (`onApplicationShutdown`).

## Pruebas de integración (Postgres aislado)

`test/persistencia-drizzle.e2e-spec.ts` corre solo si `TAXONOMY_TEST_DATABASE_URL` apunta a un Postgres desechable (nunca la base compartida de Supabase). Sin esa variable la suite se omite automáticamente, de modo que CI permanece verde.

```powershell
docker run --rm -d --name taxonomy-test -p 55432:5432 -e POSTGRES_PASSWORD=postgres postgres:16-alpine
$env:TAXONOMY_TEST_DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:55432/postgres"
npm run test:e2e
docker stop taxonomy-test
```

La suite crea esquema, roles y datos de prueba en esa base, verifica permisos efectivos (positivos y negativos), transacciones (commit/rollback), readiness y el camino `503`, y elimina el esquema al finalizar.
