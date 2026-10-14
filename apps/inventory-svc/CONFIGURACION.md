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

La suite real se habilita con `INVENTORY_REAL_INTEGRATION=1`. No requiere ni consume URLs de prueba o runtime configuradas manualmente: aprovisiona PostgreSQL y RabbitMQ efímeros mediante Docker, genera credenciales aleatorias por ejecución, publica puertos dinámicos ligados a loopback y crea un vhost de pruebas. La suite conserva la etiqueta única de ejecución y solo elimina los contenedores, volúmenes y red que tengan esa etiqueta. Necesita Docker CLI con acceso a un daemon activo y capacidad para descargar las imágenes si aún no están disponibles. Sin la variable de activación, Vitest omite estos casos; activados sin Docker operativo, fallan durante el aprovisionamiento.

La suite depende expresamente del repositorio hermano `docs`, ubicado junto a `backend` en el checkout de trabajo. Antes de ejecutarla, revisa y sincroniza el repositorio contractual para que sus migraciones de Inventario correspondan a la revisión que se está validando. La suite lee y aplica en la base temporal vacía `docs/datos/inventory-svc/migration.sql` y `docs/datos/inventory-svc/migrations/0002_order_id_operaciones_disponibilidad.sql`; no mantiene copias de estas migraciones en backend ni las ejecuta contra Supabase compartido. Si el modelo físico o las migraciones oficiales cambian, revisa primero esos archivos del repositorio `docs` y confirma que la suite aplique el conjunto vigente antes de interpretar sus resultados.

La conexión de runtime con Supabase/RabbitMQ OCI, los usuarios y permisos, así como la distribución de claves/issuer G7, siguen pendientes del frente de infraestructura y seguridad. Este documento no indica que esas conexiones existan ni estén operativas.
