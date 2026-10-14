# Configuración de inventory-svc

Esta tabla describe las variables que lee actualmente `inventory-svc`. No contiene credenciales. Los valores entre `<...>` son marcadores que deben sustituirse por el owner indicado; no son secretos válidos.

| Variable | Requisito | Ejemplo seguro | Funcionalidad | Si falta | Owner |
|---|---|---|---|---|---|
| `DATABASE_URL` | Obligatoria para operar; alternativa a las variables `PG*` | `<URL PostgreSQL de runtime aprovisionada>` | Pool PostgreSQL, Drizzle, reservas, saldos, operaciones, Kardex y Outbox | El servicio inicia sin pool y las operaciones persistentes no están disponibles | Infraestructura G6 / Supabase |
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` | Alternativa completa a `DATABASE_URL`; host, base, usuario y contraseña requeridos; puerto opcional (5432) | `<host privado>`, `5432`, `<base inventory>`, `<usuario runtime>`, `<secreto aprovisionado>` | Configura el pool PostgreSQL | Sin `DATABASE_URL` ni credenciales requeridas no hay conexión DB | Infraestructura G6 / Supabase |
| `PGSSLMODE` | Opcional | `require` | Modo SSL al crear conexión por parámetros `PG*`; `disable` desactiva SSL | El cliente aplica configuración SSL predeterminada | Infraestructura G6 |
| `PGSSLROOTCERT` | Opcional | `<ruta del certificado CA montado>` | Certificado CA para validar PostgreSQL remoto | Se usa validación TLS predeterminada del cliente | Infraestructura G6 |
| `RABBITMQ_URL` | Opcional para arranque; requerido para publicar eventos | `<URL RabbitMQ/vhost runtime aprovisionada>` | Worker de despacho Outbox | El worker conserva eventos en `PENDING` y reintenta cuando haya conexión configurada | Infraestructura G6 / owner RabbitMQ OCI |
| `G7_JWT_PUBLIC_KEY` | Obligatoria para endpoints protegidos; acepta PEM | `<PEM público provisionado por Seguridad>` | Verificación local RS256 | Fallo cerrado: token rechazado por falta de clave confiable | Seguridad G7, provisionada por Infraestructura |
| `JWT_PUBLIC_KEY` | Compatibilidad opcional; alternativa heredada a `G7_JWT_PUBLIC_KEY` | `<PEM público provisionado por Seguridad>` | Misma verificación RS256 cuando no está `G7_JWT_PUBLIC_KEY` | Sin ninguna clave configurada, endpoints protegidos rechazan tokens | Seguridad G7, provisionada por Infraestructura |
| `G7_JWT_ISSUER` | Obligatoria para endpoints protegidos | `<issuer acordado y configurado por G7>` | Validación del claim `iss` | Fallo cerrado; token rechazado | Seguridad G7 |
| `INVENTORY_SVC_PORT` | Opcional | `3005` | Puerto HTTP del servicio; precede a `PORT` | Usa `PORT` o `3005` | Owner inventory-svc |
| `PORT` | Opcional | `3005` | Puerto HTTP de respaldo | Usa `3005` | Plataforma de despliegue |
| `RESERVATION_TTL_SECONDS` | Opcional | `900` | Duración de la reserva antes de expirar | Usa `900`; entero positivo | Owner inventory-svc / Ventas para acuerdo operativo |
| `DEFAULT_LOW_STOCK_THRESHOLD` | Opcional | `5` | Umbral de disponibilidad baja por defecto | Usa `5` | Owner inventory-svc |
| `INVENTORY_WORKER_INTERVAL_MS` | Opcional | `5000` | Frecuencia de worker de expiración y Outbox (mínimo 250 ms) | Usa `5000` | Owner inventory-svc |
| `INVENTORY_WORKER_BATCH_SIZE` | Opcional | `50` | Máximo de reservas/eventos por pasada (1–500) | Usa `50` | Owner inventory-svc |

## Variables exclusivas de pruebas aisladas

La suite real nunca debe reutilizar `DATABASE_URL` ni `RABBITMQ_URL` recibidas del entorno de runtime. Solo se habilita con `INVENTORY_REAL_INTEGRATION=1` y requiere `INVENTORY_TEST_DATABASE_URL` e `INVENTORY_TEST_RABBITMQ_URL`, ambas en `localhost`, `127.0.0.1` o `::1`, además de `INVENTORY_TEST_RABBIT_CONTAINER` con prefijo `inventory-it-`. Estas variables las configura quien ejecuta el entorno efímero de pruebas; no deben apuntar a Supabase compartido ni a RabbitMQ operativo.

La conexión de runtime con Supabase/RabbitMQ OCI, los usuarios y permisos, así como la distribución de claves/issuer G7, siguen pendientes del frente de infraestructura y seguridad. Este documento no indica que esas conexiones existan ni estén operativas.
