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
