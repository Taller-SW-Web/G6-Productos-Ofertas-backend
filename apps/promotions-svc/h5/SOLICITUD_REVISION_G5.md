# Revisión G5 de la frontera HTTP H5 con G6

Continuamos los acuerdos de G5 #51 y la coordinación de G5 #64. Las cuatro rutas están documentadas en [OpenAPI 0.7.0-rc.2](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/937b7deb4bde25a282ebb52bbfd16195ad684195/contratos/http/openapi.yaml), con estado `SEMIFINAL_G6` y pendiente de homologación externa.

La arquitectura G6 adoptada usa Service Bus Basic exclusivamente interno. G5 usaría HTTPS/JWT con audiencia api-productos, sin credenciales del bus. No se atribuye aceptación G5 ni se declara el reemplazo desplegado.

## Bloques que solicitamos aprobar o corregir

1. Conservar las operaciones HTTP de reserva, confirmación y liberación. HTTP 202 solo admite; GET /api/v1/inventario/operaciones/{operationId} recupera resultado durable. Crear reserva no consume definitivamente stock.
2. Nuevos POST /api/v1/cupones/consumos y /api/v1/cupones/restauraciones, y GET /api/v1/cupones/operaciones/{operationId}?order_id=... según los schemas enlazados. Operación/Outbox se comprometen antes de 202; replay idéntico conserva identidad/resultado; contenido diferente genera conflicto. Restauración conserva consumption_operation_id y cancelled_at original.
3. Consulta GET /api/v1/inventario/reservas/{reservaId}/estado?order_id=... y seguimiento durable G5 para expiración tardía, reinicio y carreras con pago/anulación. G5 conserva sus estados y decisiones del pedido. La implementación de Inventory #240 ya está integrada a master y su homologación se verifica por separado.
4. Secuencia Marketplace con cupón: reserva creada → comprobar vigencia → cupón consumido → pago → consumo definitivo de stock. Reemplazos M1 conservan orden independiente sin cobro y consumo antes de despacho. Reintegro M2 continúa tras recepción física y aptitud, con location_id por entorno.
5. Conservar Retry-After de 2 s, backoff con jitter hasta 30 s y retención mínima de 30 días para terminales desde su estado final. Definir responsables, frecuencia de conciliación y ventana conjunta por SHA.

La implementación devuelve 400 `VALIDACION` si falta la clave o es malformada y 409 `IDEMPOTENCY_CONFLICT` para UUID válidos diferentes o una intención distinta con la misma identidad. El límite de admisión es 240 KiB del envelope completo serializado en UTF-8. Un exceso devuelve 400 `VALIDACION` y no crea una operación.

## Respuesta solicitada

Por bloque: **ACEPTAMOS / PROPONEMOS CAMBIO**, campo/texto exacto, responsable M1/M2 y fecha propuesta para provider/consumer. No publicar tokens ni secretos. Aceptación documental, grants G7, integración y despliegue son evidencias independientes.

El PR Backend #250 registra el controlador en Promotions y las rutas externas en Gateway detrás de sus flags H5 y autenticación G7. La integración sigue pendiente de ejecución conjunta en un entorno autorizado. G5 debe habilitar una fuente durable del snapshot comercial por pedido con cliente, canal, SKU, cantidades, precios y referencias, para que G6 pueda conectar el adaptador y habilitar la admisión. El piloto Pricing/Audit #234/#235 es una evidencia separada.
