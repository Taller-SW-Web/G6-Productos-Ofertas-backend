# #48 — Topología física y recuperación bloqueada

Base `poma@bb79d3bd105c8548ef46682564ab102579188b70`.
Docs master `599c34f4e677c8792532e2cc31ac372473a10710`, AsyncAPI 0.6.0-rc.3,
catálogo/topología/compatibilidad RabbitMQ y SPEC-003/004/010. DEC-F-001, -002,
-006, -009, -011 y -012. Se consultaron #29 y las guías Oracle obligatorias.

## Defectos comprobados y correcciones

1. Publisher y consumer usaban nombres físicos ingleses incompatibles con Docs.
   Se alinean solo el cliente Catalog y sus fixtures desechables a
   `po.comandos.x`, `po.eventos.x`, `po.resultados.x`, `po.catalogo.q`.
   Los nombres lógicos, routing keys comerciales, IDs y payloads se conservan.
   Las colas de Inventory/Pricing del broker de prueba usan sus nombres físicos
   canónicos, sin modificar el código de esas aplicaciones.
2. Una URL configurada activaba el consumer y sus envíos a `po.retry.x`/`po.dlx.x`
   sin gate de aprobación. Ahora el runtime compartido queda detenido antes de
   conectar, consumir o publicar; emite `AMQP_RECOVERY_BLOCKED`, no
   `AMQP_CONNECTED`. No crea timers de reconexión, no toma mensajes, no ACKea,
   no NACKea ni reemplaza la disposición pendiente por un bucle. Outbox queda
   durable pendiente y las operaciones HTTP/persistencia locales continúan.

El diseño anterior de recuperación se conserva únicamente para ensayos con
inyección explícita `isolatedTestRecovery: true` y `NODE_ENV=test`. Esa opción
no se lee de variables de entorno ni puede habilitar producción. Los recursos
de ensayo se crean exclusivamente dentro de contenedores desechables; no se
ha conectado ni modificado el broker compartido. La prueba de retry cambia su
nombre para identificarlo como diseño no aprobado, sin atribuir homologación.

## Inventario contractual y estado real

| Productor/consumidor | Mensajes lógicos | Estado interno / frontera |
|---|---|---|
| Publica comandos | pricing.product.initialization.requested; inventory.sku.initialization.requested | transacción de alta/retry y Outbox; publisher confirmado/mandatory en po.comandos.x |
| Publica eventos | catalog.product.deactivated; catalog.sku.deactivated | baja local y Outbox; po.eventos.x |
| Publica resultado de barrera | catalog.master.deactivation.checked | handler transaccional; discrepancia HAS_ACTIVE_PRODUCTS/IN_USE pendiente; AMQP compartido aislado |
| Declara resultados Bulk | catalog.bulk.upsert.completed/rejected | nombres registrados, sin caso de uso Bulk funcional; no afirmar implementación |
| Consume preparación | pricing.product.initialization.completed/rejected; inventory.sku.initialization.completed/rejected | validación, Inbox, operación/SKU/causalidad, stale/terminal/dedupe; resultado de negocio válido ACK tras commit en ensayo |
| Consume bajas Taxonomy | taxonomy.master.deactivation.check.requested; taxonomy.master.deactivated/rejected | barrera/Inbox/Outbox atómicos y finales versionados; CLEAR no libera; sin final verificable permanece bloqueado |
| Declara actualizaciones Taxonomy | taxonomy.category.updated; taxonomy.product-type-schema.changed; taxonomy.characteristic-value.updated | GenericData en AsyncAPI; handler arroja BlockedCatalogHandler; no hay proyección ficticia |
| Declara solicitud Bulk | catalog.bulk.upsert.requested | GenericData y semántica incompletos; handler bloqueado, sin payload ni resultado inventados |

`PRODUCT_TYPE_CHARACTERISTIC` ya acepta coordenadas explícitas de asociación
en el HEAD base. Solo coordina cuando esos identificadores/versiones están
presentes y verificables; las barreras históricas no resolubles siguen
bloqueando y no se liberan ni generan CLEAR ficticio. No se atribuye evidencia
de un productor López homologado a las pruebas internas.

Publisher: confirm + mandatory + retorno se distinguen; timeout/cierre no marca
publicación exitosa. Relay bloquea una fila con SKIP LOCKED y solo escribe
published_at tras confirm sin retorno. La ventana confirm→commit conserva
at-least-once y el mismo message_id. Inbox compara contenido canónico para
replay; una misma identidad con otro contenido se rechaza. COMPLETED es
terminal; los resultados causales obsoletos no revierten la preparación.

## Pruebas y condiciones de desbloqueo

Pruebas enfocadas ejecutadas: `npm test -- --maxWorkers=2
apps/catalog-svc/src/catalog-amqp`: 22 PASS. Cubren los siete destinos físicos
de publicación sin reescribir envelope, bloqueo runtime incluso con flag de
test en producción, ausencia de conexiones/timers/consumo/relay en ese estado,
ACK tras commit, duplicados/stale/terminal, rechazo de negocio, JSON inválido,
fallo de confirm, reconnect/cancelación y shutdown acotado. Son dobles de
transporte, no un broker real. La suite RabbitMQ y JOINT-01 mantienen pruebas
con broker desechable; su ejecución exacta se registra en CI/PR.

| Owner | Operación afectada | Condición verificable para desbloquear | Capa |
|---|---|---|---|
| Marco/infra + G5/owners G6 | runtime AMQP y recuperación técnica | disposición durable/versionada aprobada, recursos y permisos provisionados, ensayos de caída/saturación/recuperación sin pérdida; después adaptar el gate mediante cambio revisado | integración/despliegue AMQP; no HTTP |
| Marco/infra + G7 | acceso broker | red privada, vhost, identidad/ACL mínimos y topic permissions probados desde contenedores autorizados | integración |
| López + Marco + Poma | resultado de bajas de maestros | resolver explícitamente código HAS_ACTIVE_PRODUCTS frente a enum vigente CLEAR/IN_USE y entregar productor/consumidor compatibles con SHA y prueba bilateral | contrato/implementación de esa frontera |
| López + Marco | asociación tipo/característica | IDs autoritativos tipo/característica, version capturada y schema_version_resultante posterior; evidencia del productor y prueba conjunta | homologación de asociación |
| López + Marco | actualizaciones de proyección Taxonomy | payload tipado/efecto aprobado y versiones en AsyncAPI, más productor verificable | implementación específica |
| Castilla/Bulk + Marco | upsert masivo | payload/semántica tipados, atomicidad e idempotencia aprobadas en contrato y prueba bilateral | implementación específica |
| Vera/Taco + Poma | preparación real | resultados/replay compatibles por operación y causalidad, intercambio autenticado con SHA | integración/homologación |

No se traduce HAS_ACTIVE_PRODUCTS a IN_USE en este encargo: el alcance prohíbe
modificar payloads. La discrepancia queda explícita y el runtime compartido
aislado, sin presentar adaptación física como homologación del protocolo.
Estado #48: IMPLEMENTAR_PARCIAL; AMQP compartido BLOQUEADO_ESPECÍFICO.
