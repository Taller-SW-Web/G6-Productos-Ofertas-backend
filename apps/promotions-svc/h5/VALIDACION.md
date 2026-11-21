# Validación local Promotions H5

## Preparación funcional de la integración G5–G6

La revisión que contiene esta sección registra `COUPON_H5_FACTS_SOURCE` por DI. Lee la [evidencia privada definida para G5](CONTRATO_EVIDENCIA_CUPON_G5.md) con el cliente G6 `promotions-svc`, exige audiencia `api-ventas`, valida el snapshot y consulta el Catálogo y la reserva de G6. El procesador existente determina elegibilidad y consumo bajo transacción. Las cuatro rutas externas permanecen en OpenAPI 0.7.0-rc.2. El [runner y la matriz de 20 casos](PRUEBA_CONJUNTA_G5.md) registran las comprobaciones por revisión y ambiente.

| Nivel | Resultado |
|---|---|
| Código implementado | Adaptador HTTPS registrado, contrato estricto, cancelación dentro del presupuesto conjunto de 3000 ms y compatibilidad con los cuatro endpoints externos. El render exige el origen privado cuando se habilita el worker. |
| Pruebas locales | 217 pruebas focalizadas, 13 E2E HTTP, 10 pruebas en PostgreSQL 17 descartable y 6 pruebas del render de despliegue. El motor, Inbox, Outbox y SQL probaron consumo terminal y rechazo de evidencia inconsistente. La red G5, los tokens G7 y el broker se sustituyen en suites locales por fixtures explícitas. |
| Azure real, plano de control | Namespace Basic `g6-sb-h5-int-32cdqgbnlk7ow` en `rg-g6-sb-h5-int-fork`. Cola `g6.promotions.commands` activa, máximo de 10 entregas y DLQ observada en 0. La identidad `g6-h5-int-promotions` tiene Data Sender y Data Receiver al nivel de esa cola. El grupo contiene el bus, identidades y alertas, sin apps ni jobs del flujo. |
| Azure/G7/G6 reales, plano de datos | Pendiente. La comprobación de ARM no prueba conexión, settlement, reinicio ni readiness. GitHub tiene el environment del piloto `azure-h5-pilot-234`; falta el protegido `azure-h5` para el carril normal. [Checks del PR](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/pull/250/checks). |

### Dependencias para ejecutar las pruebas reales

| Responsable | Operación | Evidencia que desbloquea |
|---|---|---|
| Michael Orosco, G5 Ventas | [G5 #64](https://github.com/Taller-SW-Web/G5-Ventas-Postventas/issues/64) · lectura comercial y preparación de pedido/pago | Endpoint implementado, origen privado, SHA desplegado y pedido sintético con snapshot inmutable y reserva asociada. |
| G7 Seguridad | [G7 #107](https://github.com/Taller-SW-Web/Modulo-de-Seguridad/issues/107) · JWT de Ventas y cliente de Promotions | Emisión real con grants de [la solicitud G7](SOLICITUD_REVISION_G7.md), incluido `ventas:pedidos:evidencia-cupon:leer` para `promotions-svc` con audiencia `api-ventas`. |
| Infra G6 y owner de datos | [Backend #242](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/242) · Gateway, runtime, SQL y Service Bus | Workloads aislados con identidades y orígenes aprobados, migraciones revisadas en SQL aislado, rol verificado y credenciales G7 privadas. Ejecutar primero casos G6 y luego el recorrido bilateral. |

## Corrección de auditoría previa del 21/11/2026

[Backend PR #250](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/pull/250) · Backend #242 y #75. La auditoría solicitó cambios sobre `b4d49363476ec6bf96b14426ba91ccf9b63b33a9`. La evidencia de esta sección corresponde al HEAD anterior `cb6649f4028f7dcf6c6d09344b5f6bb7a34d83bc`, con [CI aprobada en esa revisión](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/44952051980).

| Hallazgo | Evidencia local | Confirmación pendiente |
|---|---|---|
| P0. Envelope y cuarentena | JSON canónico en UTF-8 con productor de transporte. Los POST aceptan el límite de 240 KiB y responden 400 `VALIDACION` al excederlo. PostgreSQL confirma cero filas para un exceso nuevo. La cuarentena conserva el ID y la intención, con alerta `MESSAGE_TOO_LARGE` y recuperación autorizada. | G6 Infra verifica el rechazo y el alerta en el namespace autorizado. |
| P0. Fuente comercial | Gateway y Promotions reales por loopback, con JWT firmado de prueba. Sin el proveedor de hechos, ambos POST responden 503 y el worker no queda disponible. | G5 entrega la fuente durable autorizada y G6 la conecta a `COUPON_H5_FACTS_SOURCE`. |
| P0. Identidad técnica | Uso de credencial propia `promotions-svc`. Inventory prueba 200 para el cliente permitido, 401 sin token o con audiencia inválida y 403 para clientes o scopes no autorizados. | G7 provisiona el grant y G6 ejecuta el [smoke privado](SOLICITUD_REVISION_G7.md#comprobación-privada-con-g7). |
| P1. Tiempo de evidencia | H4 conserva 1000 ms. PostgreSQL confirma éxito H5 a 1200 ms y cancelación H5 a 3000 ms, rollback, liberación de locks y recuperación sin otro consumo. | Validar latencia con G5 e Inventory reales. |
| P1. Durabilidad | PostgreSQL 17 descartable con migraciones históricas verificadas por SHA, SQL candidato, rol runtime y motor de cupones real. Cubre admisión/Outbox, replay, conflicto, lease/reinicio, entrega ambigua, mismo MessageId, resultado durable al momento del settlement y ausencia de DDL/DELETE. Service Bus y la evidencia externa se simulan en esta suite. | G6 valida Service Bus Basic real, RBAC, DLQ y recuperación. El owner de datos revisa la aplicación del SQL candidato en entorno autorizado. |
| P1. Trazabilidad | Las solicitudes G5, G7 y Gateway/Infra distinguen código condicionado, publicación documental y despliegue. | Revisión del auditor y homologación de los 20 escenarios por SHA/ambiente. |

### Comandos ejecutados en la corrección

| Comando | Resultado |
|---|---|
| `npm test -- apps/promotions-svc/src/coupons apps/promotions-svc/src/infrastructure/http/service-tokens.spec.ts --maxWorkers=2` | PASS, 144 pruebas en 16 archivos. |
| `npm run test:e2e -- test/g5-h5-admission.e2e-spec.ts apps/promotions-svc/test/coupon-h5-boundary.e2e-spec.ts apps/inventory-svc/test/coupon-evidence.e2e-spec.ts apps/api-gateway/test/g5-h5-routes.e2e-spec.ts --maxWorkers=2` | PASS, 13 pruebas HTTP en 4 archivos. |
| `node apps/promotions-svc/test/run-h5-postgres.mjs` | PASS, 9 pruebas sobre PostgreSQL 17 local descartable. |
| `npm run typecheck`, `npm run lint`, `npm run format:check` y `git diff --check` | PASS. Lint conserva las cuatro advertencias preexistentes. Se verificó también el formato del E2E transversal en `test/`. |

El parser de los dos POST H5 limita el cuerpo JSON HTTP a 256 KiB. El comando se verifica después con su límite de 240 KiB para el envelope serializado completo.

### Cuarentena y recuperación operacional

El relé deja la entrega sin `sent_at`, con `last_error=MESSAGE_TOO_LARGE` y `next_attempt_at=infinity`. Conserva el comando, `operation_id`, `message_id` y huella. La operación conserva `ACCEPTED` y resultado nulo. La alerta estructurada contiene solo servicio, código, fecha y ambos UUID. Infra debe alertar por ese código y conciliar también las filas cuarentenadas, para detectar alertas perdidas entre el commit y la emisión del log.

1. El owner de datos y el operador G6 verifican la operación, la entrega y el estado de procesamiento en un entorno autorizado. Registran ambos UUID, el SHA y la causa, sin copiar el payload a logs.
2. Si la causa fue un límite de transporte corregido, comprueban que el envelope original cabe tanto en 240 KiB como en el límite negociado con sus metadatos. Con autorización y registro, el owner vuelve elegible la entrega original. La actualización debe exigir ambos UUID, operación `ACCEPTED`, error `MESSAGE_TOO_LARGE`, fecha infinita, ausencia de lease y `sent_at IS NULL`. Cambia solo `next_attempt_at` a la hora actual y limpia `last_error`. La suite PostgreSQL prueba esta recuperación conservando bytes y MessageId.
3. Si el envelope original supera el límite, mantener la cuarentena y escalar al owner de la operación. Una conciliación posterior requiere preservar la intención y sus identificadores. No editar el payload, fabricar un resultado comercial ni emitir otra operación automáticamente.

Retener las operaciones terminales y sus huellas un mínimo de 30 días desde el estado terminal. La suite consulta y reintenta una operación con edad simulada de 30 días. Las operaciones pendientes, ambiguas o cuarentenadas permanecen hasta conciliación autorizada. El runtime candidato carece de permisos de purga y la entrega no incorpora ninguna tarea de borrado.

### Condiciones para homologar

G5 debe entregar el origen autorizado del snapshot por `order_id`, con cliente, canal, SKU, cantidades, precios y referencias. G7 debe confirmar grants reales para Ventas y la identidad técnica de Promotions. En G6 sigue pendiente la segunda revisión del PR y, para cualquier activación, el ambiente aislado con su data owner, migraciones autorizadas, colas y RBAC. El perfil de despliegue, los grants y los flags se mantienen fuera de esta entrega de auditoría.

## Evidencia histórica del 18/11/2026

Fecha: 2026-11-18. Rama: cueva. HEAD base: 8bf6b6ecf3e60730c945fe707769f95ffa450a8e. Cambios de esta tarea todavía sin commit; estos resultados corresponden al árbol de trabajo, no a un SHA desplegado. Antecedente funcional: Backend #75. Coordinación transversal: Backend #242, G5 #64 y G7 #107.

### Comandos y resultados históricos

| Comando | Resultado ejecutado |
|---|---|
| npm test -- --maxWorkers=2 | PASS: 2659 pruebas; 73 omitidas; 224 archivos aprobados y 2 omitidos |
| npm run test:e2e -- --maxWorkers=2 | PASS: 1046 pruebas; 270 omitidas; 39 archivos aprobados y 21 omitidos |
| node apps/promotions-svc/test/run-h5-postgres.mjs | PASS: 3 pruebas reales sobre PostgreSQL 17 local descartable; limpieza del contenedor propio confirmada |
| npm run typecheck | PASS |
| npm run build:promotions-svc | PASS |
| npm run lint | PASS, con 4 advertencias preexistentes en Bulk y Promotions; ninguna advertencia nueva |
| npm run format:check | PASS |
| git diff --check -- apps/promotions-svc | PASS |

La primera ejecución general encontró OpenSSL fuera del PATH y Docker Desktop detenido. Se utilizó el OpenSSL instalado en Git y se inició Docker Desktop en segundo plano; las ejecuciones generales posteriores terminaron con código 0. No se modificó código de otros servicios para corregir esas condiciones del entorno. Los skips de las suites generales no se cuentan como pruebas ejecutadas. La suite PostgreSQL H5 requiere opt-in y por ello se ejecutó también por separado mediante su runner.

### Evidencia histórica cubierta

- Eventos internos: selección de transporte, identidad explícita en producción, tres colas y cuatro eventos asignados, rechazo de metadatos incompatibles, commit antes del settlement, duplicados por el dispatcher existente, fallos de enlace y cierre.
- Núcleo candidato: admisión y Outbox atómicos, idempotencia y conflictos, recuperación de receipts H4 sin otra intención, consulta acotada por actor/pedido, proyección de resultado, envío ambiguo y límite del SDK, resultado persistido antes de completar.
- SQL real: rollback cuando falla la intención, reclamos concurrentes, exclusión por token, lease vencido y conservación del envío pendiente. La fixture usa una cuenta administradora local y un receipt histórico mínimo: no acredita grants mínimos, TLS, todas las migraciones ni el flujo comercial completo.
- HTTP: la aplicación Nest confirma que las tres rutas candidatas siguen respondiendo 404. No se publicaron endpoints nuevos ni se registró el worker candidato en producción.
- Preservación: se compararon hashes SHA-256 de los 72 archivos previos del checkout contra AUDITORIA_INICIAL.json; permanecen intactos. No se modificó el índice, la rama ni el HEAD.

### Estados históricos

| Estado | Resultado |
|---|---|
| Implementación interna de eventos | Implementada y validada localmente |
| Implementación candidata de cupones | Parcial: núcleo y SQL candidato probados; adaptador HTTP, fuente autoritativa y arranque productivo pendientes |
| Integración autenticada Azure/G7/G5 | NO EJECUTADA |
| Homologación externa | PENDIENTE de respuestas verificables a los issues de coordinación |
| Aplicación SQL compartida, grants y despliegue | NO EJECUTADOS |
| Publicación del cambio de código | Sin commit, push ni PR de esta entrega |

No se habilitaron campañas, productores compartidos ni el flujo candidato de cupones. No se tocó el namespace piloto, no se aplicó SQL a Supabase y no se consumieron mensajes productivos. La activación requiere cerrar las dependencias concretas de H5-SERVICE-BUS.md y asociar las evidencias operativas al SHA que finalmente se revise y despliegue.
