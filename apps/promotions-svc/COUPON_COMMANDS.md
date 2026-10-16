# Consumo y restauración de cupones — backend #33

Owner Axel Cueva, rama `cueva`. Fuente normativa: Docs
`c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b`, AsyncAPI `0.6.0-rc.2`,
SPEC-005, DEC-F-007/008/009/012 y modelo físico/migraciones 0001–0004.
Las migraciones se consumen sin cambios solo en PostgreSQL descartable.
Este avance se publica en `cueva` después del merge confirmado de #116
(`c3a6b0a`, 16/10/2026), sin abrir otro PR. Fue retirado de #116 junto con
#70/#15/#112; aquel PR integró únicamente el Gateway.

## Implementación y alcance

Se implementan los dos comandos `promotions.coupon.consumption.requested` y
`promotions.coupon.restoration.requested`, y sus cuatro resultados contractuales.
`coupon-contract.generated.ts` contiene los seis schemas extraídos de AsyncAPI,
sin campos, eventos, códigos de negocio ni endpoints nuevos.

- Validación de envelope v2, productor, operación, causalidad, fechas, datos,
  exchange/routing key y límite de tamaño. El actor autenticado viene del
  adaptador de transporte; `producer` y `appId` no prueban su identidad.
- Transacción en un solo cliente PostgreSQL, locks por pedido/operación,
  Inbox y receipt por identidad/intención/fingerprint semántico. Un replay
  devuelve el resultado persistido; un conflicto conserva la operación original.
- Consumo usa la función normativa `fn_consume_coupon`, que serializa cupos y
  conserva unicidad `(order_id,coupon_id)`. Revalida estado, vigencia, canal,
  identidad y límites; el puerto de evidencia debe comprobar también el snapshot
  durable, alcance/mínimo/elegibilidad autoritativa y reserva confirmada.
- Restauración usa el consumo persistido del pedido. Sin referencia original,
  solo admite correlación inequívoca. Una referencia explícita restaura únicamente
  su uso, aplica la política histórica y no inventa ni incrementa usos.
- Efecto, resultado, receipt y Outbox se guardan en la misma transacción. El ACK
  ocurre después del commit, aunque la publicación siga pendiente.
- Consumidor continuo con `basic.consume`, prefetch 20 y ACK manual sobre la
  cola contractual. Requiere resolver actor autenticado y delegar los otros
  eventos asignados; sin dispatcher no los descarta. Un fallo cierra su canal
  sin ACK, dejando la reentrega a la supervisión acordada, sin retry/DLX inventado.
- Outbox con `FOR UPDATE SKIP LOCKED`, publicación persistente/mandatory y
  confirmación del broker. Fallo/return/NACK/timeout conserva la fila pendiente
  con diagnóstico fijo. Un fallo después del confirm y antes del marcado puede
  repetir la publicación con el mismo message_id: entrega al menos una vez.

## Composición real y fronteras pendientes

Los providers Nest registran `CouponCommandProcessor`, `CouponCommandDeliveryHandler`
y `CouponOutbox` usando `pg@8.16.3` y `amqplib@0.10.9`. El usuario autorizó
expresamente esos dos cambios compartidos en package.json/package-lock.json el
2026-10-16; no se cambian otras dependencias. PostgreSQL usa el CA local y
`rejectUnauthorized=true`; no se utiliza el login administrativo. Las conexiones
son diferidas hasta su uso y el cierre de Nest libera pool/conexión.

El provider `COUPON_EVIDENCE_PROVIDER` por defecto rechaza con
`COUPON_EVIDENCE_UNAVAILABLE`: no hay evidencia aprobada que permita verificar
una reserva/snapshot a partir de las referencias opacas del comando. No valida
una referencia por existir ni convierte un 202 en éxito. Para integración debe
reemplazarse por el adaptador autorizado, conservando las comprobaciones propias.
La elegibilidad autoritativa de alcance/monto mínimo/proyecciones pertenece a
Promotions (#71/#72/#75), no a Ventas ni a Inventario. El provider de prueba
solo es válido en el smoke aislado; no sustituye esas reglas propias.

`CouponRuntime` integra el consumidor y `CouponOutboxPump` con el ciclo de vida
de Nest. La opción `PROMOTIONS_COUPON_RUNTIME_ENABLED` es `false` por defecto.
Activarla sin un `COUPON_RUNTIME_BOUNDARY` autorizado rechaza el arranque antes
de abrir un canal o publicar. La frontera actual rechaza expresamente: evidencia,
elegibilidad, dispatcher e identidad/ACL siguen pendientes. Una opción de entorno
no los concede ni sustituye sus pruebas.

La cola `po.promotions.q` también contiene eventos de proyecciones de #75. El dispatcher debe llamar
a este handler solo para los dos comandos y aportar el actor verificado mediante
la identidad/ACL homologada del broker; la identidad no se obtiene del JSON.
El pump reutiliza `CouponOutbox.publishOne()`, sin una segunda implementación
transaccional: procesa una publicación por vez, recupera filas pendientes tras
fallos y exige confirms para el marcado. Al cerrar Nest drena consumidor/pump
antes de cerrar pool y conexiones. Pérdida de canal detiene consumidor/pump sin
ACK adicional. No se inventa reconexión/retry/DLX productivo para sustituir el
acuerdo operativo pendiente. El pump tampoco se activa por defecto.
No se declaran colas, exchanges, políticas retry/DLX, ACL ni túneles compartidos.

| Owner                                  | Operación afectada                    | Desbloqueo verificable                                                                                                                                                     |
| -------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ventas/Inventario y coordinación Marco | Evidencia de reserva/snapshot         | Fuente contractual/autorizada para verificar las referencias opacas del comando; implementar y probar el adaptador, sin acceso cross-schema.                               |
| Axel/Promotions #71/#72/#75            | Elegibilidad autoritativa propia      | Repositorios, reglas de alcance/mínimo y proyecciones propias implementados y probados; conservar una sola implementación y respetar los prerrequisitos de esos bloques.   |
| G5/owner mensajería G6                 | Consumo/pump continuos en broker real | Conectividad/identidad/ACL y dispatcher de la cola compartida que conserve los eventos de #75; supervisión/reconexión y retry/DLX según acuerdo vigente.                   |
| Axel/configuración local               | Arranque con configuración privada    | Resuelto localmente: broker de desarrollo aislado, RABBITMQ_URL completado y arranque real de liveness PASS. La integración con el broker de G5 conserva su gate separado. |

Estado: `IMPLEMENTAR_PARCIAL`. Núcleo transaccional/adaptadores probados localmente;
suscripción continua local probada; activación en el broker compartido,
evidencia autenticada externa, homologación y despliegue no acreditados.
No se declara cerrado #33.

## Pruebas reproducibles

Resultado local histórico previo a las correcciones: 58 unitarias y 5 HTTP de Promotions PASS;
96 unitarias y 155 HTTP del árbol completo PASS; typecheck, lint, formato,
build:all y smoke de arranque compilado PASS. El smoke de PostgreSQL/RabbitMQ
pasó sus 10 escenarios y eliminó sus contenedores. Son pruebas locales del
árbol modificado, no CI de estos cambios ni integración autenticada externa.
La validación de las correcciones posteriores se registra por separado en
`CORRECCIONES-PENDIENTES.md`.

Desde la raíz: `npm test -- apps/promotions-svc --maxWorkers=1`,
`npm run test:e2e -- apps/promotions-svc --maxWorkers=1`,
`npm run build:promotions-svc` y
`node apps/promotions-svc/test/coupons.isolated.smoke.mjs`.

El smoke necesita Docker activo, imágenes `postgres:17-alpine` y
`rabbitmq:4.1-alpine`, y las cuatro migraciones oficiales descargadas previamente
en `node_modules/.cache/promotions-work/datos_promotions_migrations_<nombre>.sql`.
El nombre incluye el número, por ejemplo `0001_promotions_persistence.sql`.
Obtenerlas del commit de Docs indicado arriba con `gh api -H
'Accept: application/vnd.github.raw+json' repos/Taller-SW-Web/G6-Productos-Ofertas-docs/contents/datos/promotions/migrations/<nombre>?ref=c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b`.

El smoke crea contenedores propios con nombres UUID, puertos aleatorios ligados
a 127.0.0.1, credenciales sintéticas y datos de prueba. Al terminar elimina solo
esos contenedores. No utiliza .env.local, Supabase compartido ni el broker G5.
La evidencia se conserva en `test/evidence/coupons-isolated-2026-10-16.json` e
incluye digests de imágenes y PostgreSQL 17.11.

El parser/generador opcional recibe el AsyncAPI convertido a JSON:
`node apps/promotions-svc/test/generate-coupon-contract.mjs <asyncapi.json>`;
después aplicar Prettier al archivo generado. No se usa el YAML como runtime.

Referencias técnicas verificadas:
[transacciones pg](https://node-postgres.com/features/transactions) y
[canales/confirmaciones amqplib](https://amqp-node.github.io/amqplib/channel_api.html).

Auditoría npm: cinco findings preexistentes en la cadena de desarrollo
`@nestjs/mau` → inquirer/external-editor/tmp y undici; pg/amqplib no aparecen
como vulnerables en el resultado consultado. Se reportan por separado y no se
ejecuta audit fix ni se cambian paquetes fuera de la autorización.
