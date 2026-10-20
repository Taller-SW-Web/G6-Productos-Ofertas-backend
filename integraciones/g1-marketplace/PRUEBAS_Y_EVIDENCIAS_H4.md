# Pruebas y evidencias H4 — G1 Marketplace

Este archivo especifica evidencia mínima, no afirma ejecución. Marcar `PASS` únicamente con log/evidencia, SHA exacto, operación, entorno y responsable. Separar fixtures contractuales, mocks, datos Supabase, Oracle desplegado, respuesta BFF y E2E real.

## Matriz mínima

| Caso | Owner/proveedor | Aserción mínima | Estado al corte |
|---|---|---|---|
| Categorías elegibles y vacío | Taxonomy | `listarCategorias`, solo activas/comerciales, 200 wrapper válido | PENDIENTE_PROVIDER |
| Listado y búsqueda | Catalog | `listarProductos`, query MARKETPLACE, elegibilidad y vacío 200 | PENDIENTE_PROVIDER |
| Filtros | Catalog/Pricing | únicamente parámetros publicados; no filtrar página parcial global | BRECHA_CONTRACTUAL/PENDIENTE |
| Orden y paginación | Catalog + BFF G1 | enum mapeado, page 0→G6 1, page 1→G6 2, metadatos correctos | PENDIENTE_CONSUMER_PROVIDER |
| Detalle por slug | Catalog | elegible 200, inexistente/no elegible 404 sin motivo interno | PENDIENTE_PROVIDER |
| Producto simple | Catalog | `sku_base` vendible presente/usado según schema y reglas | PENDIENTE_PROVIDER |
| Producto variante | Catalog | `variant_id` distinto de `sku`; solo SKU elegibles, no inferencias | PENDIENTE_PROVIDER |
| Precio efectivo | Pricing | SKU autoritativo, canal, instante/vigencia, expirado y ausencia | PENDIENTE_PROVIDER |
| Disponibilidad 4 estados | Inventory/BFF | mapeo exhaustivo; `INDETERMINADO` HTTP 200 y no agotado/error | PENDIENTE_PROVIDER |
| Verificación N unidades | Inventory | `SUFICIENTE/INSUFICIENTE/INDETERMINADO`, `binding=false`, sin reserva | PENDIENTE_PROVIDER |
| Fulfillment ambiguo/ausente | G2/G5/Inventory | sin fuente única → indeterminado; contexto semántico inválido → 422 | PENDIENTE_OWNER_CONTEXT |
| Recomendaciones | Promotions/Catalog | allowlist Marketplace; no padre con precio/stock ficticio | PENDIENTE_PROVIDER |
| Promoción aplicable/no aplicable | Promotions | evaluación devuelve resultado sin mutar/consumir beneficio | PENDIENTE_HTTP_HANDLER |
| Cupón válido/inválido | Promotions | `validarCupon`, regla y error estable, no consumo | PENDIENTE_HTTP_HANDLER |
| Concurrencia carrito/deshacer | G1 + consultas G6 | versión/carrera manejada explícitamente y revalidación; no mutación silenciosa | PENDIENTE_G1_E2E |
| JWT correcto | G7/Gateway | token real firmado, `aud`, cliente, scope y allowlist correctos | PENDIENTE_GRANT_REAL |
| JWT sin scope / cliente incorrecto | G7/Gateway | denegación 403 con error contractual | PENDIENTE_SEGURIDAD |
| Expirado/firma inválida | Gateway | 401 contractual, sin fallback demo | PENDIENTE_SEGURIDAD |
| Timeout/error upstream/respuesta inválida | BFF G1/Gateway | timeout/5xx/esquema inválido se distingue de estado comercial; correlación | PENDIENTE_CONSUMER_PROVIDER |
| BFF G1 | G1 | llamada server-to-server, secreto solo servidor, mapeo DTO y códigos | PENDIENTE_INTEGRACION_REAL |
| Navegador real | G1 FE + BE + G6 | journey con BFF real, identidad/token real, datos identificados | PENDIENTE_E2E |
| Checkout/pedido/pago | G1/G5/G2 + lecturas G6 | snapshot durable, idempotencia/fingerprint/correlación; `PAGADO` solo por G5 | PENDIENTE_E2E_G5 |
| Idempotencia de operación G6 | servicio owner | mismo key/payload no duplica efecto; key reutilizada con distinto fingerprint se rechaza según contrato | PENDIENTE_POR_OPERACION |

## Ejecución reproducible requerida

Por cada fila ejecutada guardar: nombre del caso, comando/script, commit SHA de proveedor y consumidor, versión OpenAPI, ambiente, identidad/token sin secretos (ID/issuer y scopes efectivos), fixture o identificador de dataset, correlación, hora, resultado HTTP/schema, log de CI y enlace de artefacto. Los tokens se redactan. Registrar separado el estado de deploy con image digest y ambiente; no inferirlo del pipeline.

## Criterio de clasificación

- `CONTRATO_DEFINIDO`: operación y schema del OpenAPI identificados.
- `IMPLEMENTADO`: handler y camino al owner reconocidos en código del SHA indicado.
- `CI_VERIFICADA`: ejecución aprobada para el mismo SHA (workflow/run linked).
- `DESPLEGADO`: digest y ambiente confirmados.
- `AUTORIZACION_VERIFICADA`: token/grant real y pruebas positivas/negativas en el ambiente.
- `E2E_VERIFICADO`: BFF→Gateway→servicio→respuesta visible, con identidad y datos reales identificados.

Un PASS estático no convierte filas Provider/Consumer en PASS. Un mock no prueba proveedor real. HTTP 200 aislado no prueba readiness estable, autorización o E2E. Evaluación de cupón no consume y verificación de cantidades no reserva.
