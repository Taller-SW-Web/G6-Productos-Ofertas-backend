# Configuración de inventory-svc

Esta tabla describe las variables que lee actualmente `inventory-svc`. No contiene credenciales. Los valores entre `<...>` son marcadores que deben sustituirse por el owner indicado; no son secretos válidos.

| Variable | Requisito | Ejemplo seguro | Funcionalidad | Si falta | Owner |
|---|---|---|---|---|---|
| `DATABASE_URL` | Obligatoria para operar; alternativa a las variables `PG*` | `<URL PostgreSQL de runtime aprovisionada>` | Pool PostgreSQL, Drizzle, reservas, saldos, operaciones, Kardex y Outbox | El servicio inicia sin pool y las operaciones persistentes no están disponibles | Infraestructura G6 / Supabase |
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` | Alternativa completa a `DATABASE_URL`; host, base, usuario y contraseña requeridos; puerto opcional (5432) | `<host privado>`, `5432`, `<base inventory>`, `<usuario runtime>`, `<secreto aprovisionado>` | Configura el pool PostgreSQL | Sin `DATABASE_URL` ni credenciales requeridas no hay conexión DB; si `PGPORT` está presente debe ser entero 1–65535, en caso contrario el arranque falla (fail-closed) | Infraestructura G6 / Supabase |
| `PGSSLMODE` | Opcional | `require` | Modo SSL al crear conexión por parámetros `PG*`; `disable` desactiva SSL | El cliente aplica configuración SSL predeterminada | Infraestructura G6 |
| `PGSSLROOTCERT` | Opcional | `<ruta del certificado CA montado>` | Certificado CA para validar PostgreSQL remoto | Se usa validación TLS predeterminada del cliente | Infraestructura G6 |
| `RABBITMQ_URL` | Opcional para arranque; requerido para publicar y consumir mensajes | `<URL RabbitMQ/vhost runtime aprovisionada>` | Despacho Outbox y consumidor de `po.inventory.q` | Outbox conserva eventos `PENDING`; el consumidor no conecta sin URL | Infraestructura G6 / owner RabbitMQ OCI |
| `G7_JWT_PUBLIC_KEY` | Obligatoria para endpoints protegidos; acepta PEM | `<PEM público provisionado por Seguridad>` | Verificación local RS256 | Fallo cerrado: token rechazado por falta de clave confiable | Seguridad G7, provisionada por Infraestructura |
| `JWT_PUBLIC_KEY` | Compatibilidad opcional; alternativa heredada a `G7_JWT_PUBLIC_KEY` | `<PEM público provisionado por Seguridad>` | Misma verificación RS256 cuando no está `G7_JWT_PUBLIC_KEY` | Sin ninguna clave configurada, endpoints protegidos rechazan tokens | Seguridad G7, provisionada por Infraestructura |
| `G7_JWT_ISSUER` | Obligatoria para endpoints protegidos | `<issuer acordado y configurado por G7>` | Validación del claim `iss` | Fallo cerrado; token rechazado | Seguridad G7 |
| `INVENTORY_SVC_PORT` | Opcional | `3005` | Puerto HTTP del servicio; precede a `PORT` | Usa `PORT` o `3005` | Owner inventory-svc |
| `PORT` | Opcional | `3005` | Puerto HTTP de respaldo | Usa `3005` | Plataforma de despliegue |
| `RESERVATION_TTL_SECONDS` | Opcional | `900` | Duración de la reserva antes de expirar | Usa `900`; entero positivo | Owner inventory-svc / Ventas para acuerdo operativo |
| `DEFAULT_LOW_STOCK_THRESHOLD` | Opcional | `5` | Umbral de disponibilidad baja por defecto | Usa `5`; si está presente debe ser un entero >= 0, en caso contrario el arranque falla (fail-closed) | Owner inventory-svc |
| `INVENTORY_WORKER_INTERVAL_MS` | Opcional | `5000` | Frecuencia de worker de expiración y Outbox (mínimo 250 ms) | Usa `5000` | Owner inventory-svc |
| `INVENTORY_WORKER_BATCH_SIZE` | Opcional | `50` | Máximo de reservas/eventos por pasada (1–500) | Usa `50` | Owner inventory-svc |

## Endpoints de salud y readiness

- `GET /health` — **liveness** público. Responde `200` con `{ "status": "ok", "service": "inventory-svc" }` mientras el proceso esté vivo. No verifica dependencias.
- `GET /health/readiness` — **readiness** público. Verifica únicamente dependencias propias del servicio:
  - Responde `200` con `{ "status": "ready", "service": "inventory-svc" }` cuando PostgreSQL es alcanzable.
  - Responde `503` con `{ "status": "not_ready", "service": "inventory-svc" }` cuando PostgreSQL no responde.
  - El broker RabbitMQ es opcional: su ausencia conserva eventos `PENDING` en el Outbox y no marca el servicio como no listo.
  - La respuesta nunca expone DSN, credenciales, rutas ni detalles internos.

## Arranque fail-closed

El servicio valida la configuración de arranque (`loadInventoryConfig`) antes de escuchar. Un valor inválido en `INVENTORY_SVC_PORT`/`PORT`, `RESERVATION_TTL_SECONDS`, `DEFAULT_LOW_STOCK_THRESHOLD`, `INVENTORY_WORKER_INTERVAL_MS`, `INVENTORY_WORKER_BATCH_SIZE` o `PGPORT` detiene el arranque con `exit(1)` en lugar de continuar con un valor por defecto silencioso.

Los valores numéricos explícitos deben representar enteros decimales seguros; una cadena vacía o solo espacios es inválida, incluso para `PGPORT`. Los valores predeterminados se aplican únicamente cuando la variable está ausente. El intervalo del worker admite de 250 a 2147483647 ms para evitar el desbordamiento del temporizador. Los errores identifican la variable y el rango sin imprimir su valor. Cuando no se usa `DATABASE_URL`, deben estar presentes `PGHOST`, `PGDATABASE`, `PGUSER` y `PGPASSWORD`; el servicio no sustituye una base ausente por `postgres` ni una contraseña ausente por una cadena vacía.

## Acceso humano y técnico

Las rutas administrativas de Inventario requieren un JWT humano con firma RS256, `iss` igual a `G7_JWT_ISSUER`, `aud` que incluya `api-productos`, `sub` no vacío, `exp` futuro y rol `GESTOR_COMERCIAL`. Las capacidades locales de traslados se verifican adicionalmente. Un token `tipo=servicio` no habilita las rutas humanas aunque contenga un rol.

`GET /api/v1/inventario/disponibilidad` admite esa vía humana y la vía técnica contractual de Ventas/Postventa. La vía técnica conserva sus scopes/allowlists y el guard de Inventario; Marketplace/Chatbot/Retail siguen limitados a consultas comerciales. Si hay saldos en varias ubicaciones, la consulta detallada exige `location_id` explícito. La consulta de operaciones sigue siendo exclusiva de Ventas y no admite JWT humano.

## Mensajería, recuperación y límites locales

El consumidor comprueba la existencia de `po.inventory.q`, usa prefetch 20 y ACK manual posterior al commit de Inbox, saldo, operación y resultado Outbox. No crea ni modifica exchanges, colas, bindings ni permisos. La inicialización SKU de Catálogo es la única entrada con handler implementado en este bloque: crea saldo cero con versión cero y conserva saldos existentes. Otro `message_id` con la misma operación devuelve el resultado durable con `causation_id` del nuevo intento; una entrega idéntica no repite efectos ni resultados.

`inventory.bulk.stock.adjust.requested` y `catalog.sku.deactivated` quedan aislados con `BLOCKED_CONTRACT`: el AsyncAPI consultado declara `GenericData`, sin payload ejecutable suficiente. Un mensaje inválido, un contrato bloqueado o un fallo técnico pausa el consumidor y cierra el canal sin ACK. RabbitMQ puede volver a poner las entregas pendientes en la cola al cerrar el canal; este proceso no reconecta automáticamente mientras esté pausado. Requiere resolver la causa y llamar internamente a `resume()` o reiniciar. Un mensaje persistente incompatible puede bloquear el avance de esa cola compartida. No hay endpoint público de reanudación, retry/DLX productivo ni publicación a colas alternativas. La pérdida de conexión sin pausa programa reconexión a los 30 s.

El modelo físico vigente usa UUID para `message_id` y correlación de operación; el consumidor exige UUID para ambos. El envelope AsyncAPI general admite cadenas más amplias: esa discrepancia necesita resolución contractual antes de admitir otros identificadores. La validación no equivale a autenticación del productor: el aislamiento efectivo depende de credenciales/vhost/grants RabbitMQ provisionados.

Límites actuales: conexión PostgreSQL 5 s, lock 5 s, sentencia 15 s y espera de consulta 20 s; conexión AMQP con timeout de socket 5 s, creación de canal/checkQueue/prefetch/consume 5 s, confirm de publicación 3 s y cierre AMQP 3 s. Un deadline limita la espera y no cancela efectos ya enviados. Outbox conserva el mismo `message_id` al reintentar: entrega al menos una vez, con deduplicación a cargo del receptor. Sus lotes están limitados a 10 eventos, incluso si la configuración del worker es mayor. La expiración y el despacho se ejecutan por separado dentro del ciclo; un error de expiración no impide intentar Outbox.

`InventoryConsumerService.getMetrics()` informa conexión, pausa, recibidos, ACK, duplicados, rechazos, fallos y reconexiones. `InventoryWorkersService.getMetrics()` informa ciclos, fallos de expiración/publicación y duración del último ciclo. Son contadores locales en memoria accesibles por instrumentación interna; se reinician con el proceso y no hay endpoint/exportador de métricas implementado. Los errores nuevos pasan por `SanitizedLogger`; no se registra el cuerpo del comando y los errores de JSON se sustituyen por `INVALID_MESSAGE` para evitar fragmentos del payload en logs. Readiness sigue comprobando PostgreSQL y no demuestra salud del consumidor ni homologación de RabbitMQ.

## Variables exclusivas de pruebas aisladas

La suite real se habilita con `INVENTORY_REAL_INTEGRATION=1`. No requiere ni consume URLs de prueba o runtime configuradas manualmente: aprovisiona PostgreSQL y RabbitMQ efímeros mediante Docker, genera credenciales aleatorias por ejecución, publica puertos dinámicos ligados a loopback y crea un vhost de pruebas. La suite conserva la etiqueta única de ejecución y solo elimina los contenedores, volúmenes y red que tengan esa etiqueta. Necesita Docker CLI con acceso a un daemon activo y capacidad para descargar las imágenes si aún no están disponibles. Sin la variable de activación, Vitest omite estos casos; activados sin Docker operativo, fallan durante el aprovisionamiento.

La suite depende expresamente del repositorio hermano `docs`, ubicado junto a `backend` en el checkout de trabajo. Antes de ejecutarla, revisa y sincroniza el repositorio contractual para que sus migraciones de Inventario correspondan a la revisión que se está validando. La suite lee y aplica en la base temporal vacía `docs/datos/inventory-svc/migration.sql` y `docs/datos/inventory-svc/migrations/0002_order_id_operaciones_disponibilidad.sql`; no mantiene copias de estas migraciones en backend ni las ejecuta contra Supabase compartido. Si el modelo físico o las migraciones oficiales cambian, revisa primero esos archivos del repositorio `docs` y confirma que la suite aplique el conjunto vigente antes de interpretar sus resultados.

La conexión de runtime con Supabase/RabbitMQ OCI, los usuarios y permisos, así como la distribución de claves/issuer G7, siguen pendientes del frente de infraestructura y seguridad. Este documento no indica que esas conexiones existan ni estén operativas.
