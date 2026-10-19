# Compatibilidad RabbitMQ — nombres y bloqueos

## Fuentes y estados

- **Físico:** observación Oracle 2026-10-19, RabbitMQ 4.2.9, vhost `g6-productos-ofertas`: cuatro exchanges (`po.comandos.x`, `po.eventos.x`, `po.resultados.x`, `po.sin-ruta.x`), 11 colas quorum (incluye `po.catalogo.q`, `po.inventario.q`, `po.promociones.q`, `po.auditoria-precios.q`) y 57 bindings; cero conexiones/consumidores. Sin retry/DLX ni policies. No se cambió el broker.
- **AsyncAPI oficial consultado:** docs `origin/master` SHA `c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b`, versión `0.6.0-rc.2`, `contratos/eventos/asyncapi.yaml`. Es candidato contractual publicado en el repositorio; no consta homologación externa. Su `channels` usa exchanges `po.events.x`/`po.results.x`; descripción/topología candidata menciona exchanges/colas ingleses y retry/DLX.
- **Docs working tree local:** branch `docs/rabbitmq-adopcion-retry-dlx` dirty, AsyncAPI candidato rc.3 con nombres base españoles y retry/DLX pendientes; no es `origin/master`, no se cita como norma aprobada ni se cambia desde este trabajo.
- **Backend master:** no se encontró el cliente AMQP desplegado como implementación consolidada para esos servicios; la auditoría backend del 19-oct tampoco halló los nombres ingleses en `apps/` ni `ops/` de `castilla`.
- **Ramas personales:** `poma` (Catalog), `taco` (Inventory), `cueva` (Promotions) son snapshots no fusionados; sus nombres no prevalecen sobre el contrato o la topología física.

## Comparación resumida

| Rol / recurso | Oracle físico | AsyncAPI `origin/master` rc.2 | Backend master/`castilla` | Rama personal | Permiso/estado y acción |
|---|---|---|---|---|---|
| Exchanges base | `po.comandos.x`, `po.eventos.x`, `po.resultados.x`, `po.sin-ruta.x` | nombres base ingleses, según canales `po.events.x`, `po.results.x`; comandos/topología candidatos `po.commands.x` | sin cliente activo confirmado por búsqueda auditada | Catalog `poma`: English `po.retry.x`/`po.dlx.x`; Promotions `cueva`: `po.commands.x`/`po.results.x`; Inventory `taco`: verificar snapshot | Discrepancia de nombres; owner AsyncAPI/topología y Marco deben resolver antes de integrar clientes. No renombrar unilateralmente. |
| Catalog queue | `po.catalogo.q` | `po.catalog.q` | sin consumidor confirmado | `poma`: rama pendiente, no declarar homóloga | Read permitido a usuario `g6_catalogo` físicamente listado; la implementación pendiente debe solicitar confirmación del permiso/credencial y nombre antes de activar. |
| Inventory queue | `po.inventario.q` | `po.inventory.q` según contrato candidato | sin consumidor confirmado | `taco` usa outbox/inbox; nombres/routing exactos requieren inspección del código y comparación por el owner | Read/write según usuario `g6_inventario` y exchanges físicos; no asumir match del código. Bloqueado hasta reconciliar nombres y red. |
| Promotions queue | `po.promociones.q` | `po.promotions.q` candidato | no consumidor confirmado | `cueva`: comandos y resultados ingleses; test observa `po.events.x` | Usuario `g6_promociones` tiene read en cola física, write solo `po.resultados.x`; inglés no coincide. Gate específico pendiente. |
| Price audit | `po.auditoria-precios.q` | `po.price-audit.q` candidato | servicio no desplegado | `vera` branch contiene scaffold, no evidencia de publisher/consumer activo | Usuario físico read-only; confirmar necesidad/rol con contrato antes de configurar. |
| Retry/DLX | No existe; no policies | rc.2 describe retry/DLQ inglés (`po.retry.x`, `po.dlx.x`, queues `.retry`/`.dlq`) y una guía en docs puede contener inconsistencias | No existe topología runtime | `poma` referencia `po.retry.x`/`po.dlx.x` | **BLOQUEADO**. No aprobar, crear, inferir argumentos, nombres, TTL, ACK/requeue ni permisos hasta decisión/contrato reconciliado y autorización de broker. |

Las filas no enumeran valores de routing keys no inspeccionados. Para cada evento, consultar AsyncAPI del SHA citado y código exacto de rama antes de implementar. La documentación local docs pendiente puede ser material para resolver la discrepancia, nunca evidencia de homologación.

## Requisitos de desbloqueo AMQP

1. Owner contractual reconcilia names, bindings, retry/DLX y versión ejecutable; Marco confirma estado interno y solicita homologación externa cuando afecte consumidor/interface compartida.
2. Owner/Seguridad confirma usuario/vhost/permisos mínimos y entrega secretos por canal runtime privado; no añadir configure permission al servicio si no es necesario.
3. Marco/owner de plataforma aprueba mecanismo de red privada entre contenedores sin publicar 5672; actualmente no está documentado ni habilitado.
4. Prueba aislada de producer/consumer, redelivery/ACK/idempotencia y failover/deduplicación aplicables; evidencia SHA y versión de topología.
5. Solo tras gates y autorización individual, planificar operación del broker separada. Este documento no es orden de cambio.
