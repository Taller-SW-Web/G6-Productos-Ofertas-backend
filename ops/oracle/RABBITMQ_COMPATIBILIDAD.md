# Compatibilidad RabbitMQ: contrato, topología y candidatos

Para este candidato se consultó AsyncAPI `0.6.0-rc.4`, Docs `master` SHA `a7778ec1a22811c1213a94ef096ab905911342cc`. Es una candidata documental; no acredita grants, implementación, conectividad o E2E. Las referencias a versiones anteriores en esta ficha son históricas.

## Opt-in de red (preparación aislada)

El ejecutor candidato v6 y sus overlays se describen en [RABBITMQ_OPT_IN_H4.md](RABBITMQ_OPT_IN_H4.md). Solo conectan el servicio incluido en un manifiesto privado explícito; manifiesto ausente deja la red desconectada. Este selector no corrige discrepancias de exchange/queue/routing key, no concede ACL, no habilita uniformemente flags de runtime y no implementa Retry/DLX. La red e identidades de Oracle requieren auditoría actual antes de cualquier activación; la observación del 19-oct es histórica.

## Estado actual por servicio

El contrato normativo consultado es AsyncAPI `0.6.0-rc.4`, Docs `master` SHA `a7778ec1a22811c1213a94ef096ab905911342cc`. El contrato usa nombres físicos españoles. Esta versión no acredita por sí sola grants, conectividad, entrega, consumo, E2E ni homologación productiva.

| Servicio | Topología física y capacidad actual según el corte auditado | Estado operativo y homologación pendiente |
|---|---|---|
| Catalog | Cola `po.catalogo.q`; exchanges `po.comandos.x`, `po.eventos.x`, `po.resultados.x`. | Runtime productivo bloqueado por `AMQP_RECOVERY_BLOCKED`; no activar recuperación de pruebas ni afirmar Bulk↔Catalog. Requiere resolver Retry/DLX y homologar productor real, routing, identidad y recuperación. |
| Inventory | Cola `po.inventario.q`; exchanges `po.eventos.x`, `po.resultados.x`. Nombres físicos alineados en código. Tiene consumidor y publicador reales. | Falta homologación funcional externa. Publica `inventory.reservation.rejected`; no publica actualmente `inventory.consumption.rejected`. No existe handler productivo autorizado para `inventory.bulk.stock.adjust.requested`. |
| Promotions | Cola `po.promociones.q`; exchanges `po.comandos.x`, `po.eventos.x`, `po.resultados.x`. | Comandos, eventos y resultados tienen implementaciones parciales. El runtime productivo de cupones permanece bloqueado por evidencia durable de reserva/snapshot, identidad, adaptadores e idempotencia. Mantener `PROMOTIONS_COUPON_RUNTIME_ENABLED=false`. |
| Bulk | Exchange `po.comandos.x`; cola `po.masivos.q`. | El flujo de Bulk hacia Catalog tiene implementación, pero no acredita homologación ni funcionamiento en Oracle. Requiere validar productor real, identidad, permisos, topología, recuperación Catalog y E2E autorizado. |
| Combos | Consume `po.combos.q` con eventos tipados. | La implementación tipada no acredita conexión ni homologación externa; verificar mensajes, productores, ACL y readiness con evidencia bilateral. |
| Taxonomy | Cola `po.taxonomia.q`; runtime AMQP implementado. | Configurar URL/identidad e incluir el servicio en la red puede iniciar el runtime: requiere autorización de activación, ACL mínima y homologación funcional. |
| Pricing | Publica en `po.eventos.x` y `po.resultados.x`. | Producción requiere AMQPS con certificado/hostname verificados; confirmar listener y homologación de mensajes, identidad, ACL y publish confirm. |
| Price Audit | Consumidor de `po.auditoria-precios.q`; decoder `decodePriceChange` registrado. | Mantiene pendientes operativos de AMQPS, persistencia compartida y despliegue coordinado. No afirmar ausencia de implementación ni activar hasta acreditar esos gates. |

## Discrepancias externas comprobadas

### G5 — nombres físicos

Las fuentes documentales de G5 consultadas indican `po.commands.x`, `po.results.x` y `po.sales.q`; la configuración runtime de G5 no fue inspeccionada. G6 utiliza `po.comandos.x`, `po.resultados.x` y `po.ventas.q`. La nomenclatura española está adoptada internamente por G6, pero la transición externa no está homologada definitivamente. No crear aliases, exchanges paralelos ni recursos nuevos. Estas referencias actualizan los diagnósticos rc.2 que siguen como antecedente histórico, no como diagnóstico actual de código.

### G5 — resultados asíncronos

`inventory.reservation.rejected` e `inventory.consumption.rejected` son mensajes contractuales distintos. Inventory emite el primero y no emite actualmente el segundo; el consumidor G5 documenta una discrepancia que debe resolver su owner. La API G5 actualizada el 04/11 establece que `201 Created` no garantiza reserva y que un rechazo posterior puede anular el pedido. No cambiar consumidores G5 ni inventar publicaciones de Inventory.

### G5 — cupones

Los comandos `promotions.coupon.consumption.requested` y `promotions.coupon.restoration.requested` provienen de `modulo-ventas`. Los cuatro resultados de consumo/restauración corresponden a Promotions. Requieren identidad AMQP verificable, evidencia durable de reserva/snapshot, idempotencia y consumidor homologado. Mantener `PROMOTIONS_COUPON_RUNTIME_ENABLED=false` mientras no se satisfagan esas condiciones.

### Otros módulos

G1, G2, G3 y G4 mantienen sus contratos HTTP; no se identificó una cola AMQP directa para ellos en la integración G6 vigente. La conciliación offline G4/G5/G6 presenta contradicciones contractuales preexistentes, independientes del PR #209. G7 administra OAuth/JWT y grants HTTP; las ACL RabbitMQ son una autorización de infraestructura independiente. No solicitar nuevos scopes ni modificar permisos.

## Antecedente histórico rc.2

La versión AsyncAPI `0.6.0-rc.2`, Docs SHA `c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b`, y sus diagnósticos de nombres ingleses se conservan únicamente como antecedente histórico de esta ficha. El contraste de nombres por sí solo no describe el estado actual de implementación: Inventory está alineado en nombres físicos, y Taxonomy, Price Audit y otros servicios tienen capacidades AMQP implementadas conforme al corte auditado. No inferir homologación o activación productiva.

La auditoría física Oracle del 19-oct-2026 —RabbitMQ 4.2.9, vhost `g6-productos-ofertas`, exchanges y colas observados— sigue siendo evidencia histórica, no un estado actual del broker. No se han verificado en esta tarea conexiones, permisos vigentes, bindings activos ni entrega desde contenedores. La compatibilidad de código no autoriza modificar broker, ACL o contratos compartidos.
