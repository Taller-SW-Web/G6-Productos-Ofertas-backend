# Redes y puertos

## Trazabilidad

- ID: G6-ORACLE-20261017T011831Z
- Inicio UTC: 2026-10-17T01:18:31Z · Lima: 2026-10-16T20:18:31-05:00
- Fin de observación UTC: 2026-10-17T01:32:03Z · Lima: 2026-10-16T20:32:03-05:00
- Hostname: g6-po-vcn · IP pública: 157.137.205.218 · IP privada: 10.42.1.69
- VM OCI: ocid1.instance.oc1.sa-bogota-1.anrgcljrdootsrackizlzau3lpu7dgpcljyhkropav75k65zran5iqlghxba
- Usuario SSH: ubuntu
- Rama: castilla · SHA auditado: 741258510bf5350f172c165fb061643d49db439b
- SHA de master: 9cd6edcef6039ebdf9f1f94c9e991b0358ffc9de
- Archivo: REDES_Y_PUERTOS.md
- Alcance: redes Docker, aliases, listeners, firewall y conectividad desde el equipo auditor
- Estado: Docker/listeners observados; NSG y Security Lists OCI NO_VERIFICADO

## Redes Docker

| Red | Driver / scope | Internal / attachable | Miembros |
|---|---|---|---|
| g6-edge | bridge / local | false / false | Solo g6-caddy; alias caddy |
| g6-http | No existe | — | — |
| g6-po_g6_backend | bridge / local | false / false | Solo g6-po-rabbitmq-1; alias rabbitmq |

Caddy y RabbitMQ están aislados en redes distintas. No se observó red compartida. Inventory, Gateway, Catalog y Taxonomy no están conectados a una red porque no están desplegados. El overlay HTTP de castilla no está instalado y no se creó ninguna red durante la auditoría.

La topología objetivo requiere Caddy → API Gateway → Catalog/Taxonomy. El estado real termina en Caddy y no permite probar conectividad interna de servicios.

## Puertos

| Puerto | Uso esperado | Escucha/publicación | Desde auditor |
|---:|---|---|---|
| 22/TCP | SSH | 0.0.0.0 y :: | Alcanzable |
| 80/TCP | HTTP | Caddy, IPv4/IPv6 | Alcanzable |
| 443/TCP | HTTPS | Caddy, IPv4/IPv6 | Alcanzable; TLS válido |
| 443/UDP | HTTP/3 | Publicado por Docker; socket host no confirmado | NO_VERIFICADO |
| 3000/TCP | Gateway | Sin listener | No alcanzable |
| 3001/TCP | Catalog | Sin listener | No alcanzable |
| 3005/TCP | Inventory | Sin listener | No alcanzable |
| 3006/TCP | Taxonomy | Sin listener | No alcanzable |
| 5672/TCP | Rabbit AMQP | Solo 127.0.0.1 | No alcanzable |
| 15672/TCP | Rabbit Management | Solo 127.0.0.1 | No alcanzable |

Pruebas TCP limitadas al origen auditor: 22, 80 y 443 conectaron; 3000, 3001, 3005, 3006, 5672 y 15672 no conectaron. El listener Docker 2019 de administración de Caddy no está publicado en el host.

## Firewall local

UFW no está instalado. nftables/iptables muestra filtrado de INPUT con aceptación de conexiones establecidas, loopback, ICMP y TCP 22, y rechazo posterior. Docker mantiene reglas FORWARD para redes y publicación 80/443. Rabbit usa binds de loopback. No se modificó firewall. La observación no verifica reglas de OCI.

También se observó UDP 41641 de tailscaled. sshd -T anuncia AllowTcpForwarding yes y X11Forwarding yes. No se revisaron ACL/llaves por usuario ni accesibilidad externa UDP.
