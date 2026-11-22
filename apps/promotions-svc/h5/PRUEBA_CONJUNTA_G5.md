# Prueba conjunta G5–G6 H5

Usar la revisión aislada aprobada por Infra, los SHA desplegados de G5/G6 y un pedido de prueba por intención. El contrato externo es OpenAPI `0.7.0-rc.2`. La batería sigue los identificadores de la sección 5 de la respuesta de G5 al contrato, que remite a los casos de aceptación de la sección 14.

## Ejecución coordinada

1. Infra acredita la revisión aislada, el binding de identidad administrada y el origen HTTPS privado de G5. El owner de datos revisa y aplica `migrations-candidate/h5/0001_coupon_http_operations.sql` y `0002_coupon_http_runtime_role.sql` en SQL aislado; registra revisión y niega DDL y DELETE al runtime. El namespace candidato es Basic y `g6.promotions.commands` requiere Data Sender y Receiver exclusivos para Promotions.
2. Preparar `G6_SECURITY_MODE=G7_AUTHENTICATED`, `MESSAGING_PROVIDER=AZURE_SERVICE_BUS` y `PROMOTIONS_G5_COUPON_EVIDENCE_ORIGIN` con el origen HTTPS aprobado. El perfil ACA usa `NODE_ENV=production` y `G6_SERVICE_BUS_PRODUCTION_ENABLED=true` también en esta revisión aislada para exigir identidades administradas. Configurar `AZURE_CLIENT_ID`, `SERVICE_BUS_NAMESPACE_FQDN`, `PROMOTIONS_DEPENDENCY_PROBES_ENABLED=true`, orígenes privados de Catálogo/Inventory, issuer/JWKS y credenciales de G7 por referencia segura. Tras verificar grants, proveedor privado, SQL y Service Bus, habilitar `PROMOTIONS_H5_COUPON_COMMANDS_ENABLED=true` y `GATEWAY_G5_H5_ENABLED=true` en esa revisión. Mantener `PROMOTIONS_SERVICE_BUS_EVENTS_ENABLED=false` y los productores transversales deshabilitados hasta cerrar sus consumidores. Probar el `/health/ready` privado de Promotions antes de habilitar el tráfico de prueba.
3. El runner opera por etapas explícitas. G5 crea el pedido y aporta su SHA, referencia, cliente sintético y fecha efectiva. Ejecutar `preflight` con datos vigentes. Ejecutar `reserve` en G6 solo para un pedido preparado para que el runner sea el emisor de reserva. Si M1 ya envió la reserva, recuperar su operación con `follow` sin generar otra. G5 asocia la reserva a su snapshot y confirma la lectura privada. Ejecutar `coupon` al tener constancia del snapshot. El runner verifica estado de reserva, consume, espera resultado terminal, reenvía la intención idéntica y prueba un 409 por contenido distinto. M1 efectúa el pago y emite la constancia de prueba firmada. `confirm` exige esa firma y verifica otra vez el cupón terminal antes de confirmar stock.
4. Para anulación usar otro pedido ya consumido pero sin confirmar stock. G5 verifica y firma el evento original. `cancel` toma la fecha de la constancia, verifica la restauración según la política del cupón y libera stock. `expired` observa reserva ACTIVA vencida o EXPIRADA sin mutar. `auth` prueba 400/401/403 y 404 uniforme con los tokens negativos reales. Para pérdida de respuesta o reinicio, reutilizar el plan y los mismos UUID; `follow` concilia la operación en curso. Detener el componente o afectar la red solo en la ventana aprobada por Infra; comprobar las filas y DLQ antes de reanudar.
5. Para M2 ejecutar devolución/reemplazo mediante los flujos existentes de G5 y medir saldo antes y después. Para corte o reversión, pausar nuevas admisiones y mantener consulta/worker hasta conciliar por `operation_id`. Marcar un caso como aprobado solo con resultados observados y SHA de ambos participantes cuando corresponda.

El runner usa `node apps/promotions-svc/h5/ejecutar-integracion.mjs <etapa> <plan-local.json>`. Inyectar `G5_H5_VENTAS_JWT` desde el almacén autorizado. Para `auth` también se requieren `G5_H5_EXPIRED_JWT`, `G5_H5_WRONG_AUDIENCE_JWT` y `G5_H5_WRONG_SCOPE_JWT`. Fijar `G5_H5_AUTHORIZED_GATEWAY_ORIGIN` al origen aprobado y `G5_H5_MUTATIONS=integration-only` exclusivamente en la ventana de prueba autorizada. El runner registra UUID de correlación, operación, revisión, estado y códigos; los JWT se mantienen fuera del archivo y de la salida.

Plantilla de plan. Sustituir referencias y SHA por evidencia del ambiente. Guardar el plan y los UUID por caso para recuperar reintentos. Reutilizar el payload original para el mismo UUID.

```json
{
  "environment": "integration",
  "gateway": "https://gateway-integracion.example.invalid",
  "g6_sha": "<SHA desplegado G6>",
  "g6_cd_runs": {
    "api-gateway": "<ID de la ejecución oficial>",
    "promotions-svc": "<ID de la ejecución oficial>",
    "inventory-svc": "<ID de la ejecución oficial>",
    "catalog-svc": "<ID de la ejecución oficial>"
  },
  "g5_sha": "<SHA desplegado G5>",
  "order_id": "<pedido sintético G5>",
  "customer_ref": "<UUID de cliente sintético>",
  "effective_at": "<fecha efectiva original G5>",
  "reservation_id": "<UUID persistido por Inventory>",
  "location_id": "9129b578-631e-1735-8427-b683fb524380",
  "g5_snapshot_confirmed": false,
  "g5_evidence": { "payload": "<JSON UTF-8 base64url>", "signature": "<firma Ed25519 base64url>" },
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

### Constancias verificables

Para `confirm` y `cancel`, acordar con G5 su clave pública Ed25519 PEM por un canal autenticado y apuntar `G5_H5_G5_EVIDENCE_PUBLIC_KEY` a esa clave. El responsable de G5 verifica el estado real del pago o de la anulación en el ambiente y firma los bytes UTF-8 exactos del JSON. Codifica por separado esos bytes y la firma como base64url. La clave privada queda en G5. El runner comprueba firma, evento, identidad y revisiones antes de mutar G6, y registra solo el identificador de la constancia.

El contenido firmado lleva `issuer: "G5"`, `environment: "integration"`, `event` (`PAGO_CONFIRMADO` o `ANULACION_CONFIRMADA`), `event_id` persistido por G5, `occurred_at` original, `gateway` (origen HTTPS exacto), `order_id`, `reservation_id`, `coupon_operation_id`, `g5_sha` y `g6_sha`. Es un formato de evidencia para el runner. Los endpoints G6 no cambian.

Generar la clave de prueba en el entorno controlado de quien firma. Distribuir únicamente el PEM público y su huella SHA-256 por un canal autenticado ya acordado. La contraparte compara la huella antes de configurar el runner. Mantener la clave privada cifrada en custodia G5.

```sh
openssl genpkey -algorithm ED25519 -aes-256-cbc -out g5-h5.private.pem
openssl pkey -in g5-h5.private.pem -pubout -out g5-h5.public.pem
openssl pkey -pubin -in g5-h5.public.pem -outform DER -out g5-h5.public.der
openssl dgst -sha256 g5-h5.public.der
```

Después de verificar el hecho en G5, guardar los campos constatados en `evento.json` UTF-8 y firmar exactamente esos bytes. No editar el archivo después de firmarlo. Copiar el objeto resultante a `g5_evidence` en el plan privado.

```sh
openssl pkeyutl -sign -rawin -inkey g5-h5.private.pem -in evento.json -out evento.firma
openssl pkeyutl -verify -rawin -pubin -inkey g5-h5.public.pem -in evento.json -sigfile evento.firma
node --input-type=module -e 'import {readFileSync as read} from "node:fs"; console.log(JSON.stringify({payload:read("evento.json").toString("base64url"),signature:read("evento.firma").toString("base64url")}));' > constancia.json
```

### Reporte reproducible

Ejecutar `node apps/promotions-svc/h5/ejecutar-matriz.mjs manifiesto.json resultado-nuevo.json [G5-H5-NN ...]`. El manifiesto indexa por caso, por ejemplo `{"G5-H5-01":{"plan":"caso01.json","execute":true}}`. El runner produce las 20 filas, con actor, precondiciones, resultado esperado y estado. Adjunta SHA, ambiente, IDs y observaciones cuando se dispone de un plan válido. El reporte usa un archivo nuevo. Devuelve código 1 si falla un caso y 2 si quedan casos bloqueados.

Los casos supervisados aceptan `attestation` con el mismo contenedor de firma. Fijar `G5_H5_SESSION_EVIDENCE_PUBLIC_KEY` a la clave pública del responsable de homologación. La constancia incluye `case_id`, `actor`, `environment`, `gateway`, ambos SHA según corresponda, `order_id`, `operation_or_reservation_id`, `observed_at`, `observed`, `status` y `evidence_url` HTTPS sin credenciales ni parámetros. Para un PASS, `observed` debe coincidir con el código esperado de la fila. El responsable firma tras observar la evidencia de los actores involucrados.

Todo caso con etapa exige `execute: true` en el manifiesto, ejecución de esa etapa y una observación técnica satisfactoria para el mismo ambiente, SHA, pedido y UUID de operación o reserva. Sin ejecución queda `BLOCKED`. Un fallo de ejecución queda `FAIL` incluso con constancia válida. Si participa G5, G7 o G2, también hace falta una constancia válida. `G5-H5-05` exige que tanto el 202 como `COMPLETED` correspondan al UUID de consumo firmado. El reporte registra `technical_status` (`NOT_RUN`, `FAIL` o `PASS`) para la etapa y `status` para la homologación.

Cada observación automática debe coincidir con los metadatos del plan. Para los casos 01, 08 y 13 el runner filtra por el UUID de operación antes de evaluar la evidencia. Para el caso 10 filtra por UUID de reserva. El caso 13 exige una lectura válida del pedido original antes de comparar los dos 404.

Para homologar cualquier caso, usar el runner desde la red privada con `gh` y `az` autenticados para lectura de los runs, artefactos, variable de suscripción de `azure-h5` y revisiones. El runner consulta cada ejecución de `cd-services-azure.yml` en el repositorio oficial. Exige dispatch exitoso de `master` al SHA del plan, job de despliegue aprobado y el digest del artefacto `azure-image-<servicio>`. Contrasta los cuatro digests con las revisiones activas y saludables de ACA en el grupo aislado. El origen del plan debe coincidir con el FQDN del Gateway, que debe enviar el 100 % del tráfico a esa revisión. Ejecutar mientras los artefactos oficiales estén disponibles. La falta de evidencia o un cambio de revisión durante la etapa deja el caso `BLOCKED`. El reporte conserva los enlaces de runs, revisiones y digests verificados. Las pruebas locales se registran en [Validación local](VALIDACION.md).

Los casos 07, 15 y 16 requieren `follow` terminal y constancia supervisada con `runtime_evidence` firmado. Usar `operation_id` del `follow` y marcas horarias del ambiente posteriores al despliegue y anteriores a `observed_at`. Conservar en `evidence_url` las trazas depuradas y los conteos obtenidos en lectura autorizada. El supervisor verifica estos hechos antes de firmar:

| Caso | Campos de `runtime_evidence` y hechos que acreditan |
|---|---|
| G5-H5-07 | `request_operation_id` y `recovered_operation_id` coinciden con `operation_id`. `response_lost_at` precede a `recovered_at`, la operación queda `COMPLETED` y la lectura durable confirma `operation_rows: 1` y `effect_count: 1`. |
| G5-H5-15 | `message_id`, `outbox_pending_message_id` y `outbox_recovered_message_id` coinciden. Registrar `outbox_pending_at` antes del reinicio, `worker_before` y `worker_after` distintos, y la secuencia `worker_stopped_at`, `worker_restarted_at`, `outbox_recovered_at` y `terminal_at`. Este último coincide con `completed_at` del resultado terminal. |
| G5-H5-16 | `inbox_message_id` coincide con `message_id`. Cada entrada de `deliveries` incluye ese `message_id`, un `trace_id` distinto, `observed_at` y el `settlement` observado. Se exigen dos o más entregas y la última queda `COMPLETED`. La operación queda `COMPLETED` y la lectura durable confirma `inbox_rows: 1` y `effect_count: 1`. |

## Matriz de los 20 escenarios

Estado real al 21/11/2026. Los 20 casos completos quedan `BLOCKED` hasta que se pueda ejecutar y recoger la evidencia de homologación. Los casos 15 y 16 tienen evidencia real de los componentes G6: reinicio del runtime, redelivery, duplicado y settlement de una restauración sintética sin efecto comercial. El ambiente aislado sigue pendiente de los workloads del flujo y de la fixture bilateral autorizada. [Evidencia Azure](VALIDACION.md#reauditoría-del-head-740cb91).

| Caso | Comprobación | Ejecución preparada | Estado real |
|---|---|---|---|
| G5-H5-01 | Reserva y resultado durable | `reserve` / `follow` | Pendiente Gateway aislado y token G7 |
| G5-H5-02 | Reserva rechazada y M1 evita cupón/pago | `reserve` negativo + verificación M1 | Pendiente G5 y ambiente |
| G5-H5-03 | Confirmación de consumo de stock | `confirm` tras pago G5 | Pendiente bilateral |
| G5-H5-04 | Liberación por anulación | `cancel` y seguimiento M1 | Pendiente bilateral |
| G5-H5-05 | Cupón y GET terminal | `coupon` y constancia bilateral firmada | BLOCKED. Pendiente snapshot de G5 y constancia vinculada a la ejecución real |
| G5-H5-06 | Restauración del consumo original | `cancel` con fecha original y política | Pendiente bilateral |
| G5-H5-07 | Pérdida de respuesta del POST | `follow` y mismo UUID, con pérdida de respuesta y conteos firmados | BLOCKED. Reintento cubierto localmente. Pendiente evidencia del ambiente aislado |
| G5-H5-08 | Identidad reutilizada con otro contenido | Conflicto del paso `coupon` | 409 cubierto localmente; pendiente ambiente |
| G5-H5-09 | Reinicio de G5 | Reinicio M1 y `follow` | Pendiente bilateral |
| G5-H5-10 | ACTIVA y vencida | `expired` antes del barrido | Pendiente fixture y ambiente |
| G5-H5-11 | EXPIRADA entre barridos | `expired` tras barrido | Pendiente bilateral |
| G5-H5-12 | Carrera pago/anulación/vencimiento | Carrera controlada M1 con consultas de reserva | Pendiente bilateral |
| G5-H5-13 | Pedido/cliente ajeno | `auth` con ID conocido y pedido ajeno | 404 cubierto localmente; pendiente ambiente |
| G5-H5-14 | JWT válido, ausente, expirado y scope incorrecto | `auth` y smoke privado Inventory/G5 | Pruebas locales con firmas de prueba; pendiente emisión G7 real |
| G5-H5-15 | Broker/worker caído y recuperación | Outbox pendiente, reinicio, recuperación y `follow` terminal correlacionados | BLOCKED. Recuperación observada en el runtime temporal. Pendiente recorrido en Gateway aislado |
| G5-H5-16 | Entrega duplicada o settlement perdido | Entregas del mismo MessageId, un Inbox y un efecto comercial, más `follow` | BLOCKED. Duplicado y settlement observados en el runtime temporal. Pendiente efecto comercial en el ambiente aislado |
| G5-H5-17 | Devolución parcial apta | Recepción M2, reintegro y saldo antes/después | Pendiente bilateral |
| G5-H5-18 | Orden de reemplazo por CAMBIO | M2/M1, reserva y consumo antes de despacho | Pendiente G5/G2 y ambiente |
| G5-H5-19 | Corte y reversión conciliados | Pausa de admisión, consulta y conciliación por ID | Pendiente bilateral e Infra |
| G5-H5-20 | Destinos internos obligatorios | Matriz Service Bus H5 por emisor/receptor | Colas candidatas verificadas; pendiente validar workloads y efectos |
