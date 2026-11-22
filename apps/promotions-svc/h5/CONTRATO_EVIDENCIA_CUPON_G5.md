# Evidencia privada de cupón para G5 H5

**Destinatario** Michael Orosco, Ventas G5. **Estado** contrato solicitado a G5, pendiente de implementación y verificación bilateral. El externo de G6 sigue siendo OpenAPI `0.7.0-rc.2`.

`GET /api/v1/integraciones/productos/pedidos/{orderId}/evidencia-cupon`, por HTTPS privado. `orderId` identifica el pedido existente y viaja codificado como un segmento opaco. Autorizar únicamente JWT G7 de servicio con `sub=promotions-svc`, `aud` que incluya `api-ventas` y scope `ventas:pedidos:evidencia-cupon:leer`. Propagar `X-Correlation-Id` y usar `Cache-Control: no-store`. Un token inválido o dirigido a otra API devuelve 401. Un cliente o scope no autorizado devuelve 403. Un pedido sin snapshot disponible devuelve 404. Una dependencia temporal indisponible devuelve 503. G6 exige 200 `application/json` con cuerpo verificable para continuar.

G5 conserva la captura inmutable de cliente, canal, fecha efectiva, cupón, líneas y precios al crear el pedido. Una vez asociada la reserva, la lectura devuelve esa captura y el identificador exacto de la reserva. El valor de `commercial_snapshot_ref` coincide literalmente con `order_id` según la frontera H5 de consumo. Una respuesta repetida conserva los mismos hechos. Si Ventas carece de alguno, debe completar la persistencia antes de ofrecer la lectura.

El [JSON Schema del consumidor](../src/coupons/g5-coupon-snapshot.schema.json) define las propiedades exactas. Precios en cadenas decimales positivas de hasta seis decimales, sin exponente ni separador de miles. `offer_price` es `null` cuando no hubo oferta, o un valor menor o igual al regular. Las líneas se consolidan por SKU y comparten moneda. No se incluyen nombres, documentos de identidad ni indicadores de elegibilidad.

## Ejemplo 200

```json
{
  "order_id": "PED-H5-01",
  "commercial_snapshot_ref": "PED-H5-01",
  "reservation_id": "11111111-1111-4111-8111-111111111111",
  "effective_at": "2026-11-21T16:00:00Z",
  "customer_ref": "22222222-2222-4222-8222-222222222222",
  "channel_id": "MARKETPLACE",
  "coupon_code": "ENTRENA5",
  "lines": [{
    "sku": "ADI-ENT22-AZU-M",
    "product_id": "PRODUCTO-DE-EJEMPLO",
    "quantity": 1,
    "currency": "PEN",
    "regular_price": "79.90",
    "offer_price": null
  }]
}
```

## Ejemplos negativos

| Entrada o respuesta | Verificación esperada |
|---|---|
| Bearer de `modulo-ventas` aun con el scope nuevo | G5 devuelve 403 por la identidad. |
| JWT válido con audiencia solo `api-productos` | G5 devuelve 401. |
| Pedido conocido con snapshot todavía inexistente | G5 devuelve 404; G6 conserva la operación pendiente de conciliación sin consumir el cupón. |
| 200 con `order_id: "PED-AJENO"` o distinta reserva, fecha, cliente, canal o cupón | G6 descarta la respuesta. |
| 200 con `"eligible": true`, dos líneas del mismo SKU, cantidad 0 u oferta mayor al precio regular | G6 descarta la respuesta. |
| 200 válido con SKU que Catálogo no reconoce para ese producto y canal | G6 no ejecuta el consumo. |

El presupuesto del worker para G5, Catálogo e Inventory en conjunto es de 3000 ms. Catálogo verifica la asociación SKU/producto, su estado y visibilidad comercial. Inventory verifica la reserva al final de las lecturas externas. Promotions aplica las reglas y límites locales bajo transacción. Pedimos a G5 confirmar el origen privado, SHA, ambiente, fixture asociada a la reserva y resultados de los casos positivo, 401, 403 y 404.
