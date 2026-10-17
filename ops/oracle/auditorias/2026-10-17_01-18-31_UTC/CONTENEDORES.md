# Contenedores e imágenes

## Trazabilidad

- ID: G6-ORACLE-20261017T011831Z
- Inicio UTC: 2026-10-17T01:18:31Z · Lima: 2026-10-16T20:18:31-05:00
- Fin de observación UTC: 2026-10-17T01:32:03Z · Lima: 2026-10-16T20:32:03-05:00
- Hostname: g6-po-vcn · IP: 157.137.205.218
- VM OCI: ocid1.instance.oc1.sa-bogota-1.anrgcljrdootsrackizlzau3lpu7dgpcljyhkropav75k65zran5iqlghxba
- Usuario SSH: ubuntu
- Rama: castilla · SHA auditado: 741258510bf5350f172c165fb061643d49db439b
- SHA de master: 9cd6edcef6039ebdf9f1f94c9e991b0358ffc9de
- Archivo: CONTENEDORES.md
- Alcance: contenedores, imágenes, estados, healthchecks, mounts y reinicios
- Estado: inventario Docker completo; readiness de aplicaciones NO_VERIFICADO

## Contenedores presentes

Observación Docker: 2026-10-17T01:18:54Z. Docker requirió sudo -n para lecturas.

| Nombre | Imagen | Estado / health | Reinicio | Creación / inicio UTC | Compose / red | Puertos y mounts |
|---|---|---|---|---|---|---|
| g6-caddy | caddy:2.11.6-alpine, image ID sha256:d44355d3c2149dc580ce2cac735955d1c08d3d00882c30489c241aa51a5c10d9 | Up, sin healthcheck Docker | unless-stopped | 2026-10-16 15:49:06 / 15:49:07 | proyecto g6-caddy, servicio caddy; g6-edge, alias caddy | TCP 80/443 y UDP 443 publicados; volúmenes g6-caddy-config a /config, g6-caddy-data a /data; Caddyfile bind read-only |
| g6-po-rabbitmq-1 | rabbitmq:4.2.9-management | Up, HEALTHY | unless-stopped | 2026-10-15 15:54:51 / 15:54:52 | proyecto g6-po, servicio rabbitmq; g6-po_g6_backend | 5672 y 15672 solo en 127.0.0.1; volumen g6-po_rabbitmq_data a /var/lib/rabbitmq |

## Servicios de aplicación

| Servicio | Estado | Imagen | Health / readiness |
|---|---|---|---|
| API Gateway | NO DESPLEGADO | Ninguna imagen G6 presente | NO_VERIFICADO |
| Catalog | NO DESPLEGADO | Ninguna imagen G6 presente | NO_VERIFICADO |
| Taxonomy | NO DESPLEGADO | Ninguna imagen G6 presente | NO_VERIFICADO |
| Inventory | NO DESPLEGADO | Ninguna imagen G6 presente | NO_VERIFICADO |

Solo existen esos dos contenedores, ambos activos; no hay contenedores detenidos. Las imágenes visibles son node:24-bookworm-slim, Caddy, RabbitMQ, alpine:3.22 y hello-world; no hay imagen de aplicación G6. docker system df informó 5 imágenes, 2 contenedores activos, 838.9 MB de imágenes y 345.7 MB reclamables. Una imagen local no se consideró servicio desplegado.

No se pudo verificar SHA de despliegue de una aplicación. /var/lib/g6-inventory estaba vacío, sin active-image ni previous-image. No se inspeccionó el contenido interno de volúmenes.
