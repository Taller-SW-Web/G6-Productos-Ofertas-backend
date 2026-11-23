# Matriz ejecutable de escenarios G5–G6 H5

Esta matriz describe precondiciones verificables y evidencia requerida sin afirmar que exista pedido, snapshot, firma o ejecución real. `escenarios.json` es la fuente que consume `preparar-planes.mjs`. Los fixtures de integración son aportados por sus owners; el generador no inventa pedidos, reserva persistida, SKU/canal/precio/cupón ni constancias.

En todas las filas, `technical_status` registra el resultado de la etapa ejecutada; `status` registra homologación. El preflight puede quedar técnico PASS y homologación BLOCKED. Pruebas G6 con PostgreSQL/dobles se informan aparte y nunca cuentan como homologación. Evidencia SQL/Service Bus se consulta en lectura autorizada y con UUID del caso; no se consultan schemas de otro bounded context.

## G5-H5-01 — RESERVA_COMPLETED

- **Actor/owner:** G6 — G6 Inventory; G7 por emisión/grants. G5 entrega order_id sintético y confirma el snapshot.
- **Precondiciones verificables:** Pedido sintético G5 nuevo; stock visible suficiente en Inventory; SKU/canal/ubicación aprobados; Ventas JWT con inventario:reservas:crear. Una sola reserva por operation_id.
- **Pedido/reserva:** pedido nuevo ↔ nueva reserva creada por G6; guardar reservation_id devuelto en el checkpoint del runner.
- **HTTP:** POST /api/v1/inventario/reservas; GET /api/v1/inventario/operaciones/{operationId}; GET /api/v1/inventario/reservas/{reservaId}/estado?order_id=…
- **Identidad/scopes:** G7 modulo-ventas; aud api-productos; inventario:reservas:crear; lectura de operación y estado con sus scopes OpenAPI.
- **Respuesta esperada:** 202/200 de admisión y resultado durable COMPLETED; reserva ACTIVA con expires_at futuro; reintento idéntico conserva operation_id y reservation_id.
- **SQL de evidencia:** Inventory: operación idempotente + reservation/reservation_lines; consultar por operation_id y reservation_id.
- **Service Bus:** Sin publicación por la admisión HTTP; consultar Outbox de Inventory solo si el flujo aprobado la genera, con MessageId y settlement ligados a la operación.
- **Reintento/UUID estable:** Reusar order_id, operations.reserve, correlation_id y runtime state; no crear otro pedido ni reserva.

## G5-H5-02 — RESERVA_REJECTED_SIN_PAGO

- **Actor/owner:** G5+G6 — G5 M1 + G6 Inventory; G7 para JWT/grants.
- **Precondiciones verificables:** Pedido sintético G5 independiente; lectura inmediata de disponibilidad; cantidad pedida mayor que saldo; M1 debe detener cupón y pago tras rechazo.
- **Pedido/reserva:** pedido nuevo sin reserva aceptada; G5 verifica que no haya cobro ni consumo.
- **HTTP:** POST /api/v1/inventario/reservas; GET /api/v1/inventario/operaciones/{operationId}; verificación M1 en G5.
- **Identidad/scopes:** G7 modulo-ventas con inventario:reservas:crear y lecturas permitidas; G5/M1 usa sus identidades propias.
- **Respuesta esperada:** Resultado terminal REJECTED; sin reserva utilizable, sin consumo de cupón ni pago en G5.
- **SQL de evidencia:** Inventory: fila de operación terminal REJECTED; no fila de reserva activa para este pedido.
- **Service Bus:** No debe existir comando de consumo de cupón por el pedido; inspeccionar cola/destinos solo con permiso de lectura del operador G6.
- **Reintento/UUID estable:** Reusar pedido, operation_id y correlation_id. Nueva medición de saldo exige otro plan/pedido, nunca cambia el pedido de este caso.

## G5-H5-03 — STOCK_CONFIRMED

- **Actor/owner:** G5+G6 — G5 pagos y firma; G6 Inventory/Promotions; G7 grants.
- **Precondiciones verificables:** Pedido sintético pagado por G5; cupón COMPLETED; reserva vigente y aún no confirmada; constancia PAGO_CONFIRMADO firmada por G5.
- **Pedido/reserva:** pedido pagado ↔ reservation_id persistido ↔ operation_id de consumo de cupón original.
- **HTTP:** G6 verifica constancia G5; GET /api/v1/cupones/operaciones/{operationId}?order_id=…; POST /api/v1/inventario/reservas/{reservaId}/confirmar; GET /api/v1/inventario/operaciones/{operationId}.
- **Identidad/scopes:** G5 firma el pago; G7 modulo-ventas con inventario:reservas:confirmar/lectura y cupones:operaciones:leer según OpenAPI.
- **Respuesta esperada:** Confirmación de stock COMPLETED; no confirmar si el cupón no es terminal COMPLETED o la firma no coincide.
- **SQL de evidencia:** Inventory operación de confirmación y reserva confirmada; Promotions solo lectura de la operación/consumo ya terminal.
- **Service Bus:** Cualquier publicación interna se valida por MessageId y estado terminal antes del settlement; sin duplicar efecto comercial.
- **Reintento/UUID estable:** Preservar pedido, reservation_id, consumption operation_id, operations.confirm, correlation_id y los bytes firmados originales.

## G5-H5-04 — RESERVA_LIBERADA

- **Actor/owner:** G5+G6 — G5 cancelación; G6 Inventory; G7 grants.
- **Precondiciones verificables:** Pedido sintético anulado por G5 antes de confirmar stock; sin consumo previo de cupón; reserva ACTIVA; constancia ANULACION_CONFIRMADA firmada con coupon_operation_id=null.
- **Pedido/reserva:** pedido anulado ↔ reserva sin confirmar; no hay operation_id de consumo que restaurar.
- **HTTP:** G6 verifica constancia firmada; POST /api/v1/inventario/reservas/{reservaId}/liberar; GET /api/v1/inventario/operaciones/{operationId}; M1 verifica estado G5.
- **Identidad/scopes:** G5 firma anulación; G7 modulo-ventas con inventario:reservas:liberar y scope de lectura.
- **Respuesta esperada:** Restauración de cupón apuntando a una operación de consumo inexistente termina REJECTED/COUPON_IDENTITY_MISMATCH; liberación de reserva COMPLETED; ningún efecto de cupón.
- **SQL de evidencia:** Promotions: receipt de restauración REJECTED y cero coupon_uses para el pedido; Inventory: liberación idempotente de la reserva.
- **Service Bus:** Un mensaje de restauración rechazado y uno de liberación; mismo MessageId durante retries, Inbox/receipt sin efecto comercial de cupón.
- **Reintento/UUID estable:** Reusar pedido, reservation_id, operations.coupon como referencia negativa inexistente, operations.restore, operations.release, correlation_id y firma original con coupon_operation_id=null.

## G5-H5-05 — CUPON_202_Y_COMPLETED

- **Actor/owner:** G5+G6 — G5/Ventas snapshot + pedido; G6 Promotions/Inventory/Catalog; G7 grants e identidad promotions-svc.
- **Precondiciones verificables:** G5 creó pedido y snapshot inmutable completo; reserva ACTIVA, cliente/cupón elegibles; SKU/canal/precio validados en preflight; fixture sintética autorizada.
- **Pedido/reserva:** pedido ↔ snapshot con commercial_snapshot_ref igual order_id ↔ reservation_id exacto.
- **HTTP:** GET /api/v1/inventario/reservas/{reservaId}/estado?order_id=…; POST /api/v1/cupones/consumos; GET /api/v1/cupones/operaciones/{operationId}?order_id=…; POST replay idéntico y POST conflicto controlado.
- **Identidad/scopes:** G7 modulo-ventas aud api-productos: inventario:reservas:estado:leer, cupones:consumir y cupones:operaciones:leer; Promotions necesita identidad propia aud api-ventas para snapshot G5.
- **Respuesta esperada:** Primera admisión 202, GET terminal COMPLETED para mismo UUID; replay 200 mismo consumption_id; contenido distinto 409 IDEMPOTENCY_CONFLICT.
- **SQL de evidencia:** Promotions: una h5_coupon_operations, una h5_coupon_outbox, un Inbox, un coupon_command_receipt y un coupon_use asociado al pedido.
- **Service Bus:** g6.promotions.commands: un MessageId conservado en reenvíos; worker procesa snapshot G5 y Inventory antes del settlement; cola/DLQ por lectura autorizada.
- **Reintento/UUID estable:** Reusar pedido, snapshot, reserva, operations.coupon, correlation_id y cuerpo exacto; un conflicto es un plan negativo separado.

## G5-H5-06 — RESTAURACION_TERMINAL

- **Actor/owner:** G5+G6 — G5 anulación; G6 Promotions/Inventory; G7 grants.
- **Precondiciones verificables:** Pedido con consumo COMPLETED y reservation_id ligado; anulación G5 posterior con fecha efectiva original; cupón con política de restauración conocida.
- **Pedido/reserva:** restoration.operation_id nuevo ↔ consumption_operation_id original ↔ pedido/reserva originales.
- **HTTP:** POST /api/v1/cupones/restauraciones; GET /api/v1/cupones/operaciones/{operationId}?order_id=…; POST /api/v1/inventario/reservas/{reservaId}/liberar; GET resultado durable.
- **Identidad/scopes:** G5 firma ANULACION_CONFIRMADA; G7 modulo-ventas aud api-productos con cupones:restaurar y scopes de lectura/liberación.
- **Respuesta esperada:** Restauración terminal con outcome esperado del plan; liberación de reserva completada; repetición conserva el resultado original.
- **SQL de evidencia:** Promotions: receipt de restauración vinculado al consumo original, uso restaurado según política, Inbox/Outbox; Inventory: liberación idempotente.
- **Service Bus:** Mensaje de restauración con mismo MessageId/operation_id en retries; un Inbox/efecto y settlement posterior al commit.
- **Reintento/UUID estable:** Preservar order_id, reservation_id, operations.coupon (consumo original), operations.restore, operations.release, cancelled_at y firma G5.

## G5-H5-07 — INTENCION_UNICA_RECUPERADA

- **Actor/owner:** G6 — G6 runner/runtime; G7 para integración real. No requiere homologación G5 si fixture es sintética local.
- **Precondiciones verificables:** POST G6 admitido, respuesta perdida de forma controlada y operación durable aún consultable; solo en harness local o ventana aprobada.
- **Pedido/reserva:** mismo pedido y operación original; no crear segunda intención.
- **HTTP:** GET /api/v1/cupones/operaciones/{operationId}?order_id=… o GET /api/v1/inventario/operaciones/{operationId} según follow_type.
- **Identidad/scopes:** G7 JWT de prueba para rutas privadas; en producción token real G7 para Gateway.
- **Respuesta esperada:** Resultado recuperado terminal; SQL confirma una fila de operación y un único efecto; reintento conserva UUID.
- **SQL de evidencia:** Operación durable, receipt y uso únicos; consultar por operation_id/order_id.
- **Service Bus:** Correlacionar MessageId/outbox/Inbox y comprobar un efecto; no inyectar falla en ambiente compartido.
- **Reintento/UUID estable:** Reusar follow_operation_id, order_id, correlation_id y cualquier reservation_id capturada; no reemitir POST con UUID nuevo.

## G5-H5-08 — CONFLICTO_409

- **Actor/owner:** G6 — G6 Promotions; G7 solo para la integración con token real.
- **Precondiciones verificables:** Operación de consumo completada o admitida en fixture sintética; reserva confirmada/vigente y snapshot sintético explícito.
- **Pedido/reserva:** mismo order_id y operation_id; solo cambia un campo semántico en el segundo POST.
- **HTTP:** POST /api/v1/cupones/consumos replay; POST mismo operation_id con body distinto; GET operación terminal.
- **Identidad/scopes:** G7 identidad de prueba autorizada con cupones:consumir y lectura; local usa token firmado de prueba y claims explícitos.
- **Respuesta esperada:** Replay idéntico devuelve mismo resultado; cambio semántico devuelve 409 IDEMPOTENCY_CONFLICT y no crea segundo efecto.
- **SQL de evidencia:** Una operación/receipt/uso; fingerprint original sin alteración y no hay segunda fila Outbox efectiva.
- **Service Bus:** Un MessageId para intención original; deduplicación Inbox evita efecto adicional.
- **Reintento/UUID estable:** Reutilizar operation_id, body, pedido, correlation_id del original; el body conflictivo se deriva solo para el POST negativo.

## G5-H5-09 — M1_RECUPERA_AL_REINICIAR

- **Actor/owner:** G5 — G5 M1 + G6; G7 para token. Ventana de reinicio de G5.
- **Precondiciones verificables:** M1 tiene pedido sintético con operation_id persistida y respuesta G6 pendiente; reinicio de M1 autorizado en ambiente aislado.
- **Pedido/reserva:** M1 vuelve a consultar el mismo pedido/operación tras reiniciar; no crea pedido duplicado.
- **HTTP:** Operación HTTP G6 usada por M1, luego GET status durable en Gateway; ruta según operation_type en plan.
- **Identidad/scopes:** G5 identidad M1 + G7 JWT de servicio con scopes de operación/lectura aplicables.
- **Respuesta esperada:** M1 recupera resultado terminal y conserva una sola intención/pedido.
- **SQL de evidencia:** G5 evidencia de la única operación M1; G6 operación durable con el UUID referenciado.
- **Service Bus:** Correlacionar el MessageId procesado y verificar que no hubo efecto duplicado.
- **Reintento/UUID estable:** Reusar follow_operation_id, pedido y correlation_id persistidos por M1; reinicio no genera nuevos UUID.

## G5-H5-10 — ACTIVA_VENCIDA

- **Actor/owner:** G6 — G6 Inventory; fixture sintética y control de reloj/TTL.
- **Precondiciones verificables:** Reserva persistida como ACTIVA; expires_at pasado; consulta antes del barrido que materializa EXPIRADA.
- **Pedido/reserva:** pedido sintético ↔ reservation_id ya creado; no se crea pedido ni reserva durante la observación.
- **HTTP:** GET /api/v1/inventario/reservas/{reservaId}/estado?order_id=….
- **Identidad/scopes:** G7 JWT de prueba aud api-productos con inventario:reservas:estado:leer.
- **Respuesta esperada:** estado_persistido ACTIVA, vigencia_efectiva VENCIDA; permite_pago=false y permite_consumo_cupon=false.
- **SQL de evidencia:** Inventory reservation.estado sigue ACTIVA y expires_at<clock_timestamp(); no consumo asociado.
- **Service Bus:** Sin comando de consumo; observar mensajes existentes sin recibir/alterar la cola.
- **Reintento/UUID estable:** Reusar pedido/reservation_id y no modificar expires_at; repetir GET con el mismo correlation_id del plan.

## G5-H5-11 — EXPIRADA_Y_CONCILIADA

- **Actor/owner:** G5+G6 — G5 M1 + G6 Inventory; G7 grants.
- **Precondiciones verificables:** Reserva observada EXPIRADA después de barrido; M1 no cobró ni consumió cupón y concilió el rechazo.
- **Pedido/reserva:** pedido y reservation_id original quedan referenciados por la conciliación G5.
- **HTTP:** GET /api/v1/inventario/reservas/{reservaId}/estado?order_id=…; lectura de estado en G5/M1.
- **Identidad/scopes:** G7 Ventas scopes de estado; G5 M1 identidad de conciliación.
- **Respuesta esperada:** estado_persistido EXPIRADA; permite_pago=false, permite_consumo_cupon=false; M1 registra cancelación/conciliación una sola vez.
- **SQL de evidencia:** Inventory fila de reserva EXPIRADA; G5 evidencia de pedido sin pago ni consumo.
- **Service Bus:** No hay comando de consumo; cualquier evento de expiración se inspecciona por su MessageId y settlement sin mutar.
- **Reintento/UUID estable:** Pedido, reservation_id, operation_id de conciliación M1 y correlation_id estables.

## G5-H5-12 — UN_ESTADO_COMERCIAL_COHERENTE

- **Actor/owner:** G5+G6 — G5 + G6 + G7 + Infra. Sin ventana aprobada queda sin ejecutar.
- **Precondiciones verificables:** Carrera controlada entre pago, anulación y vencimiento en pedido sintético; reloj/worker bajo control de Infra/G5.
- **Pedido/reserva:** una sola reserva/pedido; conservar eventos originales y su orden temporal.
- **HTTP:** G5 payment/cancel flujos existentes; GET /api/v1/inventario/reservas/{reservaId}/estado y GET operation status, solo observación donde aplique.
- **Identidad/scopes:** G5 M1; G7 Ventas scopes de lecturas/escrituras ya definidos; JWT de servicio sin elevar grants.
- **Respuesta esperada:** Un resultado terminal coherente; no hay doble pago, consumo y restauración concurrentes ni reserva habilitada tras vencer.
- **SQL de evidencia:** G5 timeline del pedido; G6 operación/estado de reserva y cupones con timestamps correlacionados.
- **Service Bus:** Secuencia y settlement de mensajes internos correlacionados; inbox/outbox sin efecto duplicado.
- **Reintento/UUID estable:** Reusar mismo pedido, reservation_id, operation IDs por intención y timestamp original; nunca volver a firmar una mutación.

## G5-H5-13 — 404_UNIFORME

- **Actor/owner:** G6 — G6 Promotions; G7 token real para el caso de integración.
- **Precondiciones verificables:** Pedido/cliente conocido con operación real del actor; referencia de pedido ajeno válida en el formato, más UUID inexistente.
- **Pedido/reserva:** GET válido vincula la operación con pedido original; repetir la misma operación con otro order_id debe ser indistinguible del inexistente.
- **HTTP:** GET /api/v1/cupones/operaciones/{operationId}?order_id=… para original, pedido ajeno y UUID inexistente.
- **Identidad/scopes:** G7 JWT de prueba con cupones:operaciones:leer; producción requiere JWT real autorizado.
- **Respuesta esperada:** Original 200; ambos negativos 404 con mismo Problem code/title/body según contrato.
- **SQL de evidencia:** Misma fila de operación; dos respuestas 404 sin escrituras ni filtración de existencia.
- **Service Bus:** Sin publicación/settlement nuevo; evidencia de solo lectura de cola si se comprueba que no hubo efecto.
- **Reintento/UUID estable:** Reusar operation_id existente, pedido original, foreign_order_id y correlation_id; no reemplazar por nueva operación.

## G5-H5-14 — AUTORIZACION_REAL_VERIFICADA

- **Actor/owner:** G6+G7 — G7 para JWT/grants reales; G6 para controller/identity.
- **Precondiciones verificables:** Issuer/JWKS de prueba accesible; JWT de test firmado por clave de prueba para positivo; ausente, expirado, audiencia y scope inválidos son tokens explícitos de test.
- **Pedido/reserva:** No requiere pedido ni mutación; body inválido valida orden de 400 antes de autorización cuando contrato así lo define.
- **HTTP:** POST /api/v1/cupones/consumos con payload inválido/token válido; sin token, expirado, otra audiencia y scope insuficiente.
- **Identidad/scopes:** Solo claves/JWKS de test local; homologación requiere tokens reales emitidos por G7 con scopes de SOLICITUD_REVISION_G7.md.
- **Respuesta esperada:** 401 para ausente/expirado/aud inválida; 403 para scope; claims correctos alcanzan validación esperada (400) sin escribir.
- **SQL de evidencia:** Conteos de operations/outbox/inbox/uses sin cambio en las pruebas negativas.
- **Service Bus:** Cero mensajes publicados por autorización fallida.
- **Reintento/UUID estable:** Mismos JWT test en memoria durante suite; JWTs nunca en planes, logs o archivos. Cada petición usa correlation_id registrada.

## G5-H5-15 — OUTBOX_RECUPERADO_TRAS_REINICIO

- **Actor/owner:** G6 — G6 Promotions/Infra; G5 fixture sintética solo si se usa recorrido integrado.
- **Precondiciones verificables:** Outbox pendiente por fallo sintético/indisponibilidad; reiniciar worker en proceso local o ventana aislada aprobada.
- **Pedido/reserva:** un order/operation/message de prueba ligado a reserva; no usar una compra real.
- **HTTP:** GET /api/v1/cupones/operaciones/{operationId}?order_id=… tras reiniciar worker.
- **Identidad/scopes:** Identidad G6 administrada/doble local explícito; ninguna identidad G5/G7 usada en prueba local.
- **Respuesta esperada:** Mismo MessageId se recupera, una operación terminal y un efecto; follow vuelve a COMPLETED.
- **SQL de evidencia:** Una operación, un Outbox message_id; estado y attempts cambian según retry, sin segunda fila Inbox/receipt/uso.
- **Service Bus:** Doble explícito local simula send perdido; Azure real exige Data Sender/Receiver y lectura autorizada, conservar delivery/settlement.
- **Reintento/UUID estable:** Reusar order_id, operation_id, message_id, reservation_id y correlation_id; reiniciar no vuelve a generarlos.

## G5-H5-16 — UN_EFECTO_Y_SETTLEMENT

- **Actor/owner:** G6 — G6 Promotions/Infra; fixture G5 sintética si el mensaje representa un pedido.
- **Precondiciones verificables:** Mismo MessageId entregado al menos dos veces o settlement perdido; fixture de operación sintética; retries acotados.
- **Pedido/reserva:** MessageId estable ↔ una Inbox ↔ operación y efecto únicos.
- **HTTP:** GET /api/v1/cupones/operaciones/{operationId}?order_id=… tras procesar/settle.
- **Identidad/scopes:** Doble explícito de Service Bus en local; en Azure, identidad administrada G6 de mínimo privilegio.
- **Respuesta esperada:** Un efecto durable, una Inbox, última entrega COMPLETED; follower terminal COMPLETED.
- **SQL de evidencia:** Inbox por message_id=1; receipt/uso/efecto único; consultar operación por order_id.
- **Service Bus:** dos o más deliveries con message_id igual y trace_id distintos; settlement observado por cada entrega, la última COMPLETED.
- **Reintento/UUID estable:** Mantener message_id, operation_id, order_id, reservation_id, correlation_id; no generar ID nuevo para redelivery.

## G5-H5-17 — REINTEGRO_UNICO

- **Actor/owner:** G5+G6 — G5 Postventa + G6 + G7 si hay lectura/escritura; confirmar contrato antes de ejecutar.
- **Precondiciones verificables:** G5/M2 confirma recepción parcial elegible y autorización del reintegro; saldo antes capturado.
- **Pedido/reserva:** pedido original y referencia de devolución M2; cantidad recibida menor/igual a original.
- **HTTP:** Flujo existente G5/M2; lecturas de disponibilidad/pricing solo si el contrato aprobado lo requiere.
- **Identidad/scopes:** G5 Postventa/M2; G7 no concede scopes adicionales salvo contrato existente.
- **Respuesta esperada:** Un reintegro por cantidad elegible; saldo antes/después coincide con regla aceptada por G5.
- **SQL de evidencia:** G5 evidencia de devolución; G6 solo tablas del bounded context propio que cambian.
- **Service Bus:** Mensajes G6 relacionados a efecto solo si existen en topología aprobada; guardar MessageId y settlement.
- **Reintento/UUID estable:** Reusar pedido original, devolución/refund operation id, línea/cantidad e instante original.

## G5-H5-18 — REEMPLAZO_CONSUMIDO_ANTES_DESPACHO

- **Actor/owner:** G5+G6+G2 — G5+G6+G2; desbloquea contrato y fixture sandbox de G2 y ventana bilateral.
- **Precondiciones verificables:** G5 aprueba cambio; pedido de reemplazo sandbox; G2 confirma despacho detenido hasta consumo/reserva aprobados.
- **Pedido/reserva:** pedido original ↔ orden de reemplazo G5 ↔ reservation_id de reemplazo ↔ evento M2/G2.
- **HTTP:** Flujos existentes de G5 para cambio y llamadas HTTP autenticadas a G6 según OpenAPI vigente; no inventar ruta de G2.
- **Identidad/scopes:** G5 M1/M2, G7 para scopes G6 existentes, G2 operador de despacho según contrato acordado.
- **Respuesta esperada:** Reserva/consumo de reemplazo COMPLETED antes de habilitar despacho; una sola entrega física.
- **SQL de evidencia:** G5 vínculo original/reemplazo; G6 reserva y operación de reemplazo; G2 evidencia de despacho retenido/liberado.
- **Service Bus:** MessageIds y settlement de efectos internos G6; no interpretar cola externa para G2.
- **Reintento/UUID estable:** Preservar original order_id, replacement_order_id, reservation/operation UUIDs y prueba de despacho; IDs de retry estables.

## G5-H5-19 — PENDIENTES_CONCILIADOS

- **Actor/owner:** G5+G6 — G6 Infra+G5+G7 según fila; Infra aprueba ventana de corte/reversión.
- **Precondiciones verificables:** Corte/reversión aprobado; nueva admisión pausada; query y worker siguen disponibles; lista de pendientes firmada por operador.
- **Pedido/reserva:** cada pending operation_id correlaciona con su pedido/reserva y estado durable; no se descarta nada.
- **HTTP:** GET operation status para cada UUID y GET reserva cuando aplique; no POST comercial.
- **Identidad/scopes:** Credenciales operador G6 lectura; Ventas G7 para estados de pedido solo si el contrato lo requiere.
- **Respuesta esperada:** Todos los pendientes quedan clasificados terminales o documentados para intervención autorizada; no nuevo efecto duplicado.
- **SQL de evidencia:** Conteos y rows de operaciones/outbox/inbox/DLQ por operation_id, sin exponer payloads/secrets.
- **Service Bus:** peek autorizado de cola y DLQ; guardar MessageId, delivery count, settlement y counts antes/después.
- **Reintento/UUID estable:** Reusar cada operation_id/message_id y estado checkpoint; no emitir reintento hasta autorización de replay.

## G5-H5-20 — EFECTOS_VERIFICADOS_POR_DESTINO

- **Actor/owner:** G6 — Owners G6 de cada productor/consumidor e Infra; caso no ejecutable si faltan handlers.
- **Precondiciones verificables:** Manifiesto de topología vigente y aprobada; cargas/handlers propietarios disponibles en entorno, no basta lista de colas.
- **Pedido/reserva:** correlacionar emisor, destinatario y efecto por MessageId; no inventar pedido si el evento no es comercial.
- **HTTP:** No aplica a ruta Gateway; preflight de disponibilidad operativa y lecturas autorizadas.
- **Identidad/scopes:** Identidades administradas G6 y RBAC mínimo por entidad; usuarios externos sin permisos de Service Bus.
- **Respuesta esperada:** Cada destino obligatorio demuestra recepción y efecto durable; el MessageId se concilia con productor/consumer.
- **SQL de evidencia:** Outbox del productor + Inbox del consumidor + efecto en bounded context del destino, identificados por MessageId.
- **Service Bus:** Colas aprobadas por la matriz H5; peek/metricas/delivery/dead-letter con acceso autorizado; no declarar por existencia de cola.
- **Reintento/UUID estable:** MessageId/correlation_id preservados por redelivery; operación no duplica efecto.

## Preparación por fixture

Un perfil de fixture local (fuera del repositorio) debe incluir el Gateway privado autorizado, SHA G6, IDs de los cuatro runs CD G6, SHA G5 y evidencia revisada de su revisión/digest; cada pedido sintético G5 separado por caso; SKU/canal/cupón/ubicación/precio derivados del preflight vigente; reserva y cliente cuando aplique; y la firma G5 original en casos de pago/anulación. No incluir JWT, claves, secretos ni constancias ficticias.

El generador asigna una vez `correlation_id` y los operation UUID faltantes, crea los 20 planes y deja `execute:false`. No sobrescribe un directorio existente. Reusar los planes y el archivo `.runtime.json` en reintentos; no ejecutar de nuevo el generador. Los operation UUID ya persistidos de consumos/follow se proporcionan en el fixture del caso.

La verificación de los cuatro CD G6 compara run oficial, SHA, digest, revisión activa saludable y tráfico 100% en Gateway. G5 entrega evidencia de deployment de su propio repositorio; G6 conserva la referencia y exige que el verificador la marque `VERIFIED`, sin afirmar que el runner de G6 autentica el pipeline externo.
