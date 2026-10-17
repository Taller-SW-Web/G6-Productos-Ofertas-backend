# Inventario de VM

## Trazabilidad

- ID: G6-ORACLE-20261017T011831Z
- Inicio UTC: 2026-10-17T01:18:31Z · Lima: 2026-10-16T20:18:31-05:00
- Fin de observación UTC: 2026-10-17T01:32:03Z · Lima: 2026-10-16T20:32:03-05:00
- Hostname: g6-po-vcn · IP pública: 157.137.205.218 · IP privada: 10.42.1.69
- VM OCI: ocid1.instance.oc1.sa-bogota-1.anrgcljrdootsrackizlzau3lpu7dgpcljyhkropav75k65zran5iqlghxba
- Usuario SSH: ubuntu
- Rama: castilla · SHA auditado: 741258510bf5350f172c165fb061643d49db439b
- SHA de master: 9cd6edcef6039ebdf9f1f94c9e991b0358ffc9de
- Archivo: INVENTARIO_VM.md
- Alcance: SO, hardware, capacidad, almacenamiento, reloj, servicios y rutas
- Estado: observación SSH completa; NSG y Security Lists OCI NO_VERIFICADO

## Plataforma y capacidad

| Propiedad | Observación |
|---|---|
| SO / kernel | Ubuntu 24.04.5 LTS; Linux 7.0.0-1013-oracle x86_64 |
| OCI | sa-bogota-1, VM.Standard.E5.Flex, obtenido de IMDS |
| CPU / memoria | 4 CPU; 11 GiB RAM; 877 MiB usados y 10 GiB disponibles |
| Swap | 0 |
| Raíz | ext4, 45 GiB; 3.7 GiB usados y 41 GiB disponibles |
| /boot | ext4, 881 MiB; 653 MiB disponibles |
| Uptime / carga | 3 días 17 h; load 0.08 / 0.14 / 0.10 |
| Reloj | Etc/UTC, sincronizado; systemd-timesyncd activo |
| Interfaces | 10.42.1.69/24; la IP pública corresponde a la IP de referencia auditada |

No se observó presión de CPU, memoria o disco. La falta de swap es un riesgo de capacidad futuro, no una falla de disponibilidad observada.

## Servicios y runtime

- Docker Engine 29.9.0, API 1.56; Docker Compose v5.6.0.
- docker.service, containerd.service y systemd-timesyncd.service activos.
- tailscaled activo.
- UFW no instalado; se consultaron reglas nftables/iptables sin modificarlas.
- Caddy y RabbitMQ operan como contenedores, no como servicios systemd nativos observados.

## Rutas observadas

| Ruta | Estado | Propietario / modo |
|---|---|---|
| /usr/local/sbin/deploy-inventory-svc | Archivo, 259 bytes | root:root 755 |
| /usr/local/lib/g6-productos-ofertas | Existe | root:root 755 |
| /usr/local/lib/g6-productos-ofertas/deploy-g6-service | Archivo, 7500 bytes | root:root 755 |
| /usr/local/lib/g6-productos-ofertas/service-registry.sh | Archivo, 4035 bytes | root:root 644 |
| /opt/g6-productos-ofertas | Existe | ubuntu:ubuntu 750 |
| /opt/g6-productos-ofertas/caddy/conf | Existe | root:root 750 |
| /opt/g6-productos-ofertas/shared | Existe | root:root 755 |
| /opt/g6-productos-ofertas/inventory | Existe | root:g6-inventory-deploy 750 |
| /var/lib/g6-inventory | Existe, vacío | inventory-deploy:g6-inventory-deploy 700 |
| /var/lib/g6-productos-ofertas | No existe | — |
| /etc/g6-inventory | Existe | root:g6-inventory-deploy 750 |
| /etc/g6-inventory/runtime.env | Existe; contenido no leído | root:g6-inventory-deploy 640 |
| /etc/g6-api-gateway | No existe | — |
| /etc/g6-catalog-svc | No existe | — |
| /etc/g6-taxonomy-svc | No existe | — |

La existencia de runtime.env de Inventory no prueba conectividad o readiness. No se leyeron valores privados ni se escribieron archivos en Oracle.
