# RabbitMQ

## Trazabilidad

- ID: G6-ORACLE-20261017T011831Z
- Inicio UTC: 2026-10-17T01:18:31Z · Lima: 2026-10-16T20:18:31-05:00
- Fin de observación UTC: 2026-10-17T01:32:03Z · Lima: 2026-10-16T20:32:03-05:00
- Hostname: g6-po-vcn · IP: 157.137.205.218
- VM OCI: ocid1.instance.oc1.sa-bogota-1.anrgcljrdootsrackizlzau3lpu7dgpcljyhkropav75k65zran5iqlghxba
- Usuario SSH: ubuntu
- Rama: castilla · SHA auditado: 741258510bf5350f172c165fb061643d49db439b
- SHA de master: 9cd6edcef6039ebdf9f1f94c9e991b0358ffc9de
- Archivo: RABBITMQ.md
- Alcance: estado, vhosts, exchanges, colas, bindings, conexiones, redes y persistencia
- Estado: solo lectura; autenticación y readiness de clientes NO_VERIFICADAS

## Contenedor y persistencia

Observación del contenedor: 2026-10-17T01:19:23Z; topología: 01:20:13Z.

- g6-po-rabbitmq-1 está activo y HEALTHY; rabbitmq-diagnostics check_running confirmó que el nodo está arrancado.
- Imagen rabbitmq:4.2.9-management; proyecto/servicio Compose g6-po/rabbitmq; reinicio unless-stopped.
- Red g6-po_g6_backend, separada de g6-edge.
- Volumen persistente g6-po_rabbitmq_data montado en /var/lib/rabbitmq.
- 5672/TCP y 15672/TCP enlazados solo a 127.0.0.1.

## Topología observada

El vhost g6-productos-ofertas existe. También aparece el vhost g6.

Exchanges de aplicación: po.comandos.x (topic), po.eventos.x (topic), po.resultados.x (topic), po.sin-ruta.x (fanout).

Hay 11 colas po.*; todas durables y tipo quorum: po.combos.q, po.precios.q, po.sin-ruta.q, po.ventas.q, po.catalogo.q, po.auditoria-precios.q, po.taxonomia.q, po.pasarela.q, po.promociones.q, po.masivos.q y po.inventario.q.

- Bindings listados: 68.
- Mensajes: 0.
- Consumidores: 0.
- Conexiones: 0.
- Las routing keys observadas abarcan catálogo, taxonomía, promociones, precios, inventario, combos, masivos, ventas y pasarela.

Se consultaron nombres, tipos, durabilidad y conteos, no mensajes. No se publicaron ni consumieron mensajes. No se consultaron usuarios, contraseñas, cookies Erlang ni valores runtime. No se modificó RabbitMQ.

## Límites

La existencia de vhost/topología no verifica autenticación AMQP, grants, TLS, compatibilidad de todos los mensajes AsyncAPI, productores, consumidores, reintentos/DLX ni integración E2E. Cero conexiones y consumidores significa que no hay evidencia de clientes activos al corte, no que el broker esté fallando.
