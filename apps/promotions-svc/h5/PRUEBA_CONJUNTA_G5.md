# Prueba conjunta G5–G6 H5

Usar la revisión aislada aprobada por Infra, los SHA desplegados de G5/G6 y un pedido de prueba por intención. El contrato externo es OpenAPI `0.7.0-rc.2`. La batería sigue los identificadores de la sección 5 de la respuesta de G5 al contrato, que remite a los casos de aceptación de la sección 14.

## Ejecución coordinada

1. Infra acredita la revisión aislada, el binding de identidad administrada y el origen HTTPS privado de G5. El owner de datos revisa y aplica `migrations-candidate/h5/0001_coupon_http_operations.sql` y `0002_coupon_http_runtime_role.sql` en SQL aislado; registra revisión y niega DDL y DELETE al runtime. El namespace candidato es Basic y `g6.promotions.commands` requiere Data Sender y Receiver exclusivos para Promotions.
2. Preparar `G6_SECURITY_MODE=G7_AUTHENTICATED`, `MESSAGING_PROVIDER=AZURE_SERVICE_BUS` y `PROMOTIONS_G5_COUPON_EVIDENCE_ORIGIN` con el origen HTTPS aprobado. El perfil ACA usa `NODE_ENV=production` y `G6_SERVICE_BUS_PRODUCTION_ENABLED=true` también en esta revisión aislada para exigir identidades administradas. Configurar `AZURE_CLIENT_ID`, `SERVICE_BUS_NAMESPACE_FQDN`, `PROMOTIONS_DEPENDENCY_PROBES_ENABLED=true`, orígenes privados de Catálogo/Inventory, issuer/JWKS y credenciales de G7 por referencia segura. Tras verificar grants, proveedor privado, SQL y Service Bus, habilitar `PROMOTIONS_H5_COUPON_COMMANDS_ENABLED=true` y `GATEWAY_G5_H5_ENABLED=true` en esa revisión. Mantener `PROMOTIONS_SERVICE_BUS_EVENTS_ENABLED=false` y los productores transversales deshabilitados hasta cerrar sus consumidores. Probar el `/health/ready` privado de Promotions antes de habilitar el tráfico de prueba.
3. El runner opera por etapas explícitas. G5 crea el pedido y aporta su SHA, referencia, cliente sintético y fecha efectiva. Ejecutar `preflight` con datos vigentes. Ejecutar `reserve` en G6 solo para un pedido preparado para que el runner sea el emisor de reserva. Si M1 ya envió la reserva, recuperar su operación con `follow` sin generar otra. G5 asocia la reserva a su snapshot y confirma la lectura privada. Ejecutar `coupon` al tener constancia del snapshot. El runner verifica estado de reserva, consume, espera resultado terminal, reenvía la intención idéntica y prueba un 409 por contenido distinto. M1 efectúa el pago. Ejecutar `confirm` después de verificar la referencia del pago de prueba de G5. El runner verifica otra vez el cupón terminal antes de confirmar stock.
4. Para anulación usar otro pedido ya consumido pero sin confirmar stock. G5 registra la anulación original y su fecha. `cancel` verifica el resultado de restauración de la política de ese cupón y libera stock. `expired` observa reserva ACTIVA vencida o EXPIRADA sin mutar. `auth` prueba 400/401/403 y 404 uniforme con los tokens negativos reales. Para pérdida de respuesta o reinicio, reutilizar el plan y los mismos UUID; `follow` concilia la operación en curso. Detener el componente o afectar la red solo en la ventana aprobada por Infra; comprobar las filas y DLQ antes de reanudar.
5. Para M2 ejecutar devolución/reemplazo mediante los flujos existentes de G5 y medir saldo antes y después. Para corte o reversión, pausar nuevas admisiones y mantener consulta/worker hasta conciliar por `operation_id`. Marcar un caso como aprobado solo con resultados observados y SHA de ambos participantes cuando corresponda.

El runner usa `node apps/promotions-svc/h5/ejecutar-integracion.mjs <etapa> <plan-local.json>`. Inyectar `G5_H5_VENTAS_JWT` desde el almacén autorizado. Para `auth` también se requieren `G5_H5_EXPIRED_JWT`, `G5_H5_WRONG_AUDIENCE_JWT` y `G5_H5_WRONG_SCOPE_JWT`. Fijar `G5_H5_AUTHORIZED_GATEWAY_ORIGIN` al origen aprobado y `G5_H5_MUTATIONS=integration-only` exclusivamente en la ventana de prueba autorizada. El runner registra UUID de correlación, operación, revisión, estado y códigos; los JWT se mantienen fuera del archivo y de la salida.

Plantilla de plan. Sustituir referencias y SHA por evidencia del ambiente. Guardar el plan y los UUID por caso para recuperar reintentos. Reutilizar el payload original para el mismo UUID.

```json
{
  "environment": "integration",
  "gateway": "https://gateway-integracion.example.invalid",
  "g6_sha": "<SHA desplegado G6>",
  "g5_sha": "<SHA desplegado G5>",
  "order_id": "<pedido sintético G5>",
  "customer_ref": "<UUID de cliente sintético>",
  "effective_at": "<fecha efectiva original G5>",
  "reservation_id": "<UUID persistido por Inventory>",
  "location_id": "9129b578-631e-1735-8427-b683fb524380",
  "g5_snapshot_confirmed": false,
  "g5_payment_ref": "<referencia verificada de pago sandbox>",
  "cancelled_at": "<fecha original de anulación del otro pedido>",
  "expected_restore_outcome": "RESTORED",
  "operations": {
    "reserve": "<UUID único>",
    "coupon": "<UUID único>",
    "confirm": "<UUID único>",
    "restore": "<UUID único>",
    "release": "<UUID único>"
  }
}
```

Para `follow`, añadir `follow_type` (`inventario` o `cupones`) y `follow_operation_id`. Para el caso 02, establecer `expected_reserve_status=REJECTED` y usar un pedido independiente; el runner solicita más unidades que el saldo de la consulta inmediatamente anterior. El paso preflight verifica disponibilidad real, precio y descuento. Las referencias históricas de S/ 79,90 y S/ 3,99 sirven para comparar con lo observado, sin sobrescribir la evidencia actual.

## Matriz de los 20 escenarios

Estado real al 21/11/2026. Azure confirmó la cola y el RBAC para los casos 15/16/20. La identidad administrada de Promotions abrió el enlace de envío y pudo consultar la cola y la DLQ por AMQP sobre WebSocket. Esta comprobación acredita acceso al broker. El ambiente aislado sigue pendiente de los workloads del flujo y de la fixture bilateral autorizada. [Evidencia Azure](VALIDACION.md#preparación-funcional-de-la-integración-g5g6).

| Caso | Comprobación | Ejecución preparada | Estado real |
|---|---|---|---|
| G5-H5-01 | Reserva y resultado durable | `reserve` / `follow` | Pendiente Gateway aislado y token G7 |
| G5-H5-02 | Reserva rechazada y M1 evita cupón/pago | `reserve` negativo + verificación M1 | Pendiente G5 y ambiente |
| G5-H5-03 | Confirmación de consumo de stock | `confirm` tras pago G5 | Pendiente bilateral |
| G5-H5-04 | Liberación por anulación | `cancel` y seguimiento M1 | Pendiente bilateral |
| G5-H5-05 | Cupón y GET terminal | `coupon` | Cubierto localmente con SQL real y dependencias externas simuladas; pendiente snapshot G5 y ambiente |
| G5-H5-06 | Restauración del consumo original | `cancel` con fecha original y política | Pendiente bilateral |
| G5-H5-07 | Pérdida de respuesta del POST | `follow` y mismo plan; corte de red coordinado | Reintento local cubierto; pendiente ambiente |
| G5-H5-08 | Identidad reutilizada con otro contenido | Conflicto del paso `coupon` | 409 cubierto localmente; pendiente ambiente |
| G5-H5-09 | Reinicio de G5 | Reinicio M1 y `follow` | Pendiente bilateral |
| G5-H5-10 | ACTIVA y vencida | `expired` antes del barrido | Pendiente fixture y ambiente |
| G5-H5-11 | EXPIRADA entre barridos | `expired` tras barrido | Pendiente bilateral |
| G5-H5-12 | Carrera pago/anulación/vencimiento | Carrera controlada M1 con consultas de reserva | Pendiente bilateral |
| G5-H5-13 | Pedido/cliente ajeno | `auth` con ID conocido y pedido ajeno | 404 cubierto localmente; pendiente ambiente |
| G5-H5-14 | JWT válido, ausente, expirado y scope incorrecto | `auth` y smoke privado Inventory/G5 | Pruebas locales con firmas de prueba; pendiente emisión G7 real |
| G5-H5-15 | Broker/worker caído y recuperación | Pausa autorizada y `follow` al reiniciar | Acceso a Service Bus real verificado. Pendiente caída/reinicio con el worker aislado |
| G5-H5-16 | Entrega duplicada o settlement perdido | Trazas de MessageId, receipts y DLQ; `follow` | Peek real de cola y DLQ verificado. Duplicados y settlement probados en PostgreSQL local con transporte simulado; pendiente ejecución Azure |
| G5-H5-17 | Devolución parcial apta | Recepción M2, reintegro y saldo antes/después | Pendiente bilateral |
| G5-H5-18 | Orden de reemplazo por CAMBIO | M2/M1, reserva y consumo antes de despacho | Pendiente G5/G2 y ambiente |
| G5-H5-19 | Corte y reversión conciliados | Pausa de admisión, consulta y conciliación por ID | Pendiente bilateral e Infra |
| G5-H5-20 | Destinos internos obligatorios | Matriz Service Bus H5 por emisor/receptor | Colas candidatas verificadas; pendiente validar workloads y efectos |
