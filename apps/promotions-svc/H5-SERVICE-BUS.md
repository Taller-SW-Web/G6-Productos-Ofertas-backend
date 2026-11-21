# Promotions H5 eventos internos y preparación de cupones

Fecha: 2026-11-18. Rama local: cueva. Tarea autorizada por Axel en este chat; antecedentes #75 y piloto #234/#235. Alcance de código: apps/promotions-svc. No modifica el piloto ni código de otros servicios, Gateway, dependencias o workflows.

## Fuentes y estados

Docs fijado a c1f7fabd16f46643b6dd6fb480bd925428da7f7c: OpenAPI 0.6.0-rc.5, AsyncAPI 0.6.0-rc.4, SPEC-005/006, DEC-F-007/008/009/012, acuerdos internos G6 y candidata HTTP H5. Se leyeron las guías Oracle requeridas como antecedentes; sus cortes históricos no sustituyen la ADR H5 adoptada ni prueban conectividad actual.

- IMPLEMENTAR_AHORA: receptor SDK de los cuatro eventos asignados, tres colas internas, selección explícita, aislamiento de transporte, integración del dispatcher existente y readiness interna.
- IMPLEMENTAR_PARCIAL: admisión, consulta, relay y worker de cupones registrados en Nest con habilitación explícita. El worker requiere una fuente autorizada de snapshot y la identidad técnica dedicada de Inventory antes de admitir comandos.
- BLOQUEADO_ESPECIFICO: fuente de snapshot G5, emisión real y grants G7, y liberación G6 de la imagen, migración y configuración. Los estados se registran por separado.

## Entrega uno eventos internos

service-bus-events.ts compone el SDK con PromotionsAssignedEventDispatcher y los adapters H4 actuales. Catalog mantiene los writers de proyección y el guard de versiones SQL. Pricing/Inventory mantienen las invalidaciones durables en Inbox; no se inventan precios ni disponibilidad agregada desde un evento de stock físico.

| Cola | Productor esperado | Eventos |
|---|---|---|
| g6.promotions.from.catalog | catalog-svc | catalog.product.deactivated, catalog.sku.deactivated |
| g6.promotions.from.pricing | pricing-svc | pricing.price.changed |
| g6.promotions.from.inventory | inventory-svc | inventory.stock.changed |

La configuración identifica el namespace aprobado. Infra debe comprobar Sender exclusivo por cola y Receiver de Promotions; una propiedad producer del mensaje no es una credencial. Se validan cola/nombre/productor, MessageId, correlationId, subject, contentType, schema_version y route_version=1. No hay autenticación por headers HTTP ni por productor declarado aislado.

Se verifican los tres enlaces antes de suscribirse. Peek-Lock con autoCompleteMessages=false y un handler concurrente por cola. Primero commit de Inbox/proyección o invalidación; después complete. Un fallo SQL abandona el mensaje; un mensaje inválido usa DLQ con razón fija sin registrar su cuerpo. Un fallo de settlement después de commit no se convierte en rechazo de negocio. El fn_begin_inbox normativo compara el envelope de entregas repetidas.

Los probes periódicos revalidan enlace; readiness interna observa el worker seleccionado. No se añade ruta HTTP de readiness. El cierre drena suscripciones/tareas y cierra recursos SDK en onModuleDestroy antes del pool SQL en onApplicationShutdown.

## Variables respaldadas por el parser

| Variable | Comportamiento |
|---|---|
| MESSAGING_PROVIDER | Ausente/RABBITMQ conserva H4; AZURE_SERVICE_BUS selecciona H5; otro valor falla |
| SERVICE_BUS_NAMESPACE_FQDN | Host Azure exacto, sin esquema/path/credenciales |
| PROMOTIONS_SERVICE_BUS_EVENTS_ENABLED | true explícito para iniciar los consumidores; no habilita cupones |
| G6_SERVICE_BUS_PRODUCTION_ENABLED | true obligatorio en producción H5; se rechaza true en desarrollo/test |
| AZURE_CLIENT_ID | Identidad administrada explícita obligatoria en producción; cuando se define no hay fallback a usuario CLI |
| G6_SECURITY_MODE | Producción H5 exige G7_AUTHENTICATED; no acredita grant real |
| RABBITMQ_URL | Debe estar ausente en selección Azure; no se acepta un segundo transporte |
| PROMOTIONS_COUPON_RUNTIME_ENABLED | El runtime H4 debe permanecer false en H5 |
| PROMOTIONS_H5_COUPON_COMMANDS_ENABLED | Habilita las rutas H5 y el ciclo de trabajo de `g6.promotions.commands` con G7. Por defecto es false |
| PROMOTIONS_H5_COUPON_ADMISSION_PAUSED | Pausa los POST durante el drenaje. GET y worker siguen activos. Por defecto es false |
| PROMOTIONS_H5_SERVICE_CLIENT_SECRET | Credencial técnica de `promotions-svc` para el scope privado de estado de reserva. Es distinta de la credencial `modulo-productos` |
| PROMOTIONS_DEPENDENCY_PROBES_ENABLED | Habilita monitor/probes existentes; usar true en validación operativa |

Se conservan PG/TLS, puerto, upstreams y configuración de auth existentes. El pool usa verify-full/CA; no se lee ni publica configuración privada. No habilitar esta configuración sobre el namespace piloto ni en apps compartidas sin su revisión y evidencia de RBAC/productores.

## Entrega dos núcleo candidato de admisión y resultado

OpenAPI 0.7.0-rc.2 documenta los tres endpoints de cupones como `SEMIFINAL_G6` y `PENDIENTE_HOMOLOGACION_EXTERNA`. La admisión exige que `commercial_snapshot_ref` coincida literalmente con `order_id`. El módulo de Promociones registra el controlador y el runtime. La preparación del Gateway sobre `master` conserva las cuatro rutas externas detrás de `GATEWAY_G5_H5_ENABLED` y `G7_AUTHENTICATED`.

- prepareCouponH5Admission valida DTO candidato, actor que deberá provenir de G7, UUID de correlación y clave de idempotencia. Restauración candidata exige la referencia al consumo original sin cambiar la compatibilidad H4.
- CouponH5Operations.admit toma el lock de operación compatible con el procesador existente, compara fingerprint/actor/intención y compromete operación+Outbox en la misma transacción. Devuelve solo después del commit. Replay usa el recurso y MessageId originales.
- También verifica los receipts históricos H4: otro fingerprint falla; un resultado terminal compatible se recupera sin encolar otro comando. Resultados históricos incompletos/incoherentes siguen siendo fallo técnico, no éxito supuesto.
- get usa operación, pedido y actor en la misma consulta. Recurso ajeno y ausente dan la misma ausencia al futuro adaptador. No publica ni reejecuta.
- CouponH5DeliveryStore reclama con SKIP LOCKED, lease de 30 s y token; envía fuera de la transacción SQL. Finaliza solo con token/lease vigentes. Envío ambiguo conserva intención e ID. El límite completo se comprueba con tryAddMessage del SDK.
- Sobretamaño conserva la intención con MESSAGE_TOO_LARGE y reintento infinito deshabilitado; requiere revisión operativa. El rechazo síncrono o tamaño admitido de la futura API debe cerrarse contractualmente, sin convertir esto en un rechazo de cupón inventado.
- CouponH5Worker exige correspondencia con la admisión persistida y usa CouponCommandProcessor existente, incluyendo límites, reserva, snapshot, restauración y receipt. No reemplaza CouponEvidenceProvider por fixtures.
- Processor compromete efecto, receipt y resultado Outbox juntos. Después se persiste el snapshot H5 antes de completar el mensaje interno. Si falla ese segundo commit, la reentrega recupera el receipt sin otro efecto.
- El resultado íntegro se conserva internamente; la vista candidata elimina campos no publicados como cupon_id.
- Las filas de resultados en el Outbox histórico se conservan. No se marca published_at ni se enciende el pump AMQP en H5; su clasificación/retención es parte del corte, no un backfill implícito.

`g6.promotions.commands` está activa en el entorno aislado H5 desde el 20 de noviembre. La identidad administrada de Promotions tiene los dos roles de datos en esa cola. El relay usa `promotions-svc` como productor del envelope y el worker contrasta el mensaje recibido con la admisión SQL. El actor de negocio sigue siendo `modulo-ventas`. Falta verificar el ciclo completo con las aplicaciones ejecutándose en Azure.

El runtime comprueba los permisos de las tablas y ambos enlaces de la cola antes de aceptar comandos nuevos. Tras arrancar, una caída del broker permite conservar nuevas intenciones mediante commit SQL. Un envío confirmado sin resultado terminal se vuelve elegible tras 60 segundos con el mismo MessageId. El commit terminal detiene el replay aunque se pierda el acuse del broker.

Inventory reutiliza la lectura de estado persistido y la restringe al cliente técnico `promotions-svc`. Su evidencia de reserva se verifica independientemente de los datos del snapshot comercial. Falta el adaptador para la fuente G5 autorizada de ese snapshot, que se conecta mediante `COUPON_H5_FACTS_SOURCE`. Hasta disponer de ella y de la credencial G7 dedicada, el worker no abre el transporte y los POST no confirman admisión.

## SQL candidato y prueba reproducible

migrations-candidate/h5/0001_coupon_http_operations.sql agrega únicamente h5_coupon_operations y h5_coupon_outbox. No edita históricos y no se ejecuta en bootstrap. No se aplicó a Supabase ni otro entorno compartido.

`0002_coupon_http_runtime_role.sql` requiere que el owner indique el rol existente de la aplicación mediante `SET LOCAL g6.promotions_h5_runtime_role`, dentro de la transacción de migración. Otorga `SELECT`, `INSERT` y `UPDATE` en ambas tablas. Rechaza roles con DDL, pertenencia a los roles propietarios o privilegios altos. No concede purga ni crea roles compartidos.

Antes de una migración definitiva, revisar modelo/ledger, owner y grants mínimos, retención, índices y compatibilidad. La cuenta runtime no debe tener DDL. Cualquier exposición de schema/RLS se revisa con el owner de datos; el candidato no autoriza acceso público.

Prueba opt-in solo contra base local VACÍA y descartable cuyo nombre comience g6_promotions_h5_test_. El test rechaza otra ubicación/nombre y un schema promotions ya presente. No elimina la base automáticamente.

Con Docker disponible, el runner crea una base local descartable y elimina únicamente su propio contenedor, previa comprobación de su etiqueta:

~~~powershell
node apps/promotions-svc/test/run-h5-postgres.mjs
~~~

Para una base local descartable administrada manualmente:

~~~powershell
$env:PROMOTIONS_H5_POSTGRES_TESTS='1'
$env:PROMOTIONS_H5_TEST_DATABASE_URL='<URL privada de la base local descartable>'
npm run test:e2e -- apps/promotions-svc/test/coupon-h5.postgres.e2e-spec.ts --maxWorkers=1
~~~

La prueba SQL aplica las migraciones históricas verificadas y las dos candidatas en PostgreSQL descartable. Ejecuta admisión, reintentos, cuarentena y consumo con el procesador de cupones bajo el rol runtime. Azure Service Bus y la fuente comercial se simulan en la suite. La [evidencia y el procedimiento de recuperación](h5/VALIDACION.md) detallan la verificación pendiente en el ambiente autorizado.

## Coordinación ya enviada

- G5: https://github.com/Taller-SW-Web/G5-Ventas-Postventas/issues/64
- G7: https://github.com/Taller-SW-Web/Modulo-de-Seguridad/issues/107
- Gateway/BFF/Infra G6: https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/242

El conector de GitHub respondió 403; los mismos pedidos se publicaron mediante GitHub CLI autenticado. Los cuerpos locales están en h5/SOLICITUD_REVISION_G5.md, SOLICITUD_REVISION_G7.md y SOLICITUD_GATEWAY_INFRA.md.

No se atribuyen respuesta, aceptación, grant ni compromiso de otros owners a la apertura de un issue.

## Dependencias de cierre

| Responsable | Frontera | Condición concreta |
|---|---|---|
| G5/G6 Docs | Tres rutas de cupones | Homologar la ejecución contra la versión publicada y verificar el límite de 240 KiB del envelope completo |
| G7 | HTTP | Verificar los grants de los scopes dedicados del OpenAPI y probar autorización real con `modulo-ventas` |
| G5/Inventory/G6 | Reserva y snapshot | Fuente autorizada con hechos durables verificables; mientras tanto evidencia sigue bloqueada |
| Arquitectura/integración G6 | BFF y productores compartidos | Resolver todos los destinatarios/handlers requeridos antes del corte |
| Infra/owners | Azure | Namespace/colas/identidades/RBAC por ambiente, prueba positiva/negativa, alerts/DLQ y recuperación sin tráfico |
| Owner datos/QA | SQL | Revisar modelo/grants y validar el runtime de negocio completo antes de aplicación compartida; suite transaccional local ejecutada |

Inventory #240 se fusionó en `master`. Se prepararon y probaron la ruta correspondiente del Gateway y la evidencia privada de Inventory en una copia aislada del `master` oficial `81f66c8`. El perfil Azure G5 H5 separado del piloto #234 asigna las identidades existentes y mantiene Inventory y Promociones con una réplica mínima. Los despliegues y los veinte escenarios con consumidores reales requieren su propia evidencia.

## Preparación de la sesión G5 del 21 de noviembre

La respuesta documental de G5 acepta los campos de las cuatro rutas y la secuencia de reserva, cupón y pago. Para el provider G6, conservar los scopes dedicados del contrato `0.7.0-rc.2`. `modulo-ventas` usa `cupones:consumir`, `cupones:restaurar`, `cupones:operaciones:leer` e `inventario:reservas:estado:leer` con audiencia `api-productos`. G7 verifica los grants efectivos y G6 prueba los permisos en Gateway y en cada servicio.

- Aplicar `Retry-After: 2` en la primera admisión de cupón. El consumidor conserva operación y payload al reintentar, y usa backoff con jitter de hasta 30 segundos. Conservar los resultados y las huellas de idempotencia por al menos 30 días desde el estado terminal. Mantener toda operación pendiente, ambigua o en revisión hasta resolución del owner. La persistencia candidata no tiene purga automática. Para límites de tráfico, falta medir la política de la infraestructura que recibirá la prueba.
- Para la prueba Marketplace usar `ADI-ENT22-AZU-M`, cantidad 1, `ENTRENA5`, cliente UUID de prueba y `ALM-LURIN` (`9129b578-631e-1735-8427-b683fb524380`). Catálogo devolvió los tres SKU activos con medidas positivas. En Lurín se observaron 25 Adidas, 18 Nike Revolution y 26 Nike Everyday. Pricing devolvió S/ 79,90. La validación de solo lectura de `ENTRENA5` devolvió `valid: true`, descuento S/ 3,99 y total S/ 75,91. Caso de prueba del canal Marketplace, independiente del consumo H5 de Ventas.
- Enviar `location_id` de Lurín para las pruebas de disponibilidad. Azure devolvió `400 VALIDACION` sin ubicación y `200` con Lurín. El OpenAPI permite omitirla cuando existe una única ubicación inequívoca. La revisión activa de Inventory no define `RESERVATION_TTL_SECONDS`, y su código usa 900 segundos por defecto. El E2E debe registrar el `expires_at` emitido al completar la reserva.
- Inventory debe publicar el GET de estado fusionado en #240 y entregar la evidencia privada de reserva definida en OpenAPI. G5 es el owner del snapshot comercial de pedido. Queda pendiente una fuente verificable y autorizada de ese snapshot para el worker de cupones. El texto de `order_id` identifica el snapshot, mientras que la elegibilidad exige comprobar sus datos y aplicar las reglas propias de Promociones.
- Infra/Gateway debe preparar la revisión G7 separada para la prueba. La revisión G7 observada en Azure recibe 0 % del tráfico público. Antes del corte, ejecutar los veinte escenarios, verificar efectos durables y registrar los SHA de G5/G6. Para reintegro positivo, usar una devolución apta con `source_ref`, `operation_id` y stock antes y después en un entorno autorizado.

## Publicación y operación

Mantener este diff separado del piloto y de cambios previos del checkout. La evidencia marketplace-native-2026-11-04.json preexistente está fuera del cambio. No usar git add . ni publicar la historia antigua de cueva como si fuera un incremento limpio.

Publicar/revisar el código, aplicar SQL, provisionar Azure, configurar/reiniciar apps y efectuar el corte son acciones separadas. No se hizo deploy, cambio de grant, activación de campaña, replay ni modificación de mensajes/datos productivos.

Antes de activar: tokens reales G7, evidencia real de SQL/Azure, productores compatibles con metadatos y sus destinatarios completos; después pruebas de caída/reinicio, duplicados, pérdidas de confirmación, resultados tardíos y transición sin RabbitMQ supuesto como fallback.

Orden del release G6 para la sesión conjunta:

1. Integrar los cambios de Promociones, Inventory, Gateway y el perfil Azure sobre el `master` vigente. El CD oficial solo admite su SHA exacto con CI aprobada e imagen oficial por digest. La fase de validación aislada no requiere cambiar el tráfico del Gateway HTTP actual.
2. Aplicar `0001` y `0002` con el owner de datos al entorno aislado. Registrar la versión de la migración y comprobar el rol con SELECT/INSERT/UPDATE sin CREATE/DELETE. Confirmar las cuatro colas y sus asignaciones de datos acotadas a entidad.
3. Renderizar el perfil `--service-bus-g5-h5` con el namespace y las dos identidades de ese entorno. Arrancar Inventory y Promociones con una réplica mínima. Mantener deshabilitados los productores compartidos durante la prueba HTTP aislada hasta acreditar consumidores y efectos de todos sus destinos obligatorios.
4. Conectar el snapshot autorizado de G5 y configurar el cliente G7 dedicado para Inventory. Activar el Gateway solo en una revisión G7 y comprobar los endpoints con credenciales verificadas y fixtures trazables. Ejecutar los veinte casos antes de mover tráfico o aprobar el corte.
5. Si se requiere detener admisión, activar `PROMOTIONS_H5_COUPON_ADMISSION_PAUSED` y conservar el GET y el worker. Conciliar por `operation_id` los pendientes, resultados y DLQ antes de revertir o detener consumidores.

## Verificación

Los resultados ejecutados y sus límites se registran al terminar en h5/VALIDACION.md. Liveness/lecturas públicas no acreditan los estados pendientes de este documento.
