# Seguridad y tratamiento de datos

## Trazabilidad

- ID: G6-ORACLE-20261017T011831Z
- Inicio UTC: 2026-10-17T01:18:31Z · Lima: 2026-10-16T20:18:31-05:00
- Fin de observación UTC: 2026-10-17T01:32:03Z · Lima: 2026-10-16T20:32:03-05:00
- Hostname: g6-po-vcn · IP: 157.137.205.218
- VM OCI: ocid1.instance.oc1.sa-bogota-1.anrgcljrdootsrackizlzau3lpu7dgpcljyhkropav75k65zran5iqlghxba
- Usuario SSH: ubuntu
- Rama: castilla · SHA auditado: 741258510bf5350f172c165fb061643d49db439b
- SHA de master: 9cd6edcef6039ebdf9f1f94c9e991b0358ffc9de
- Archivo: SEGURIDAD.md
- Alcance: SSH, firewall local, Docker, permisos y tratamiento de secretos
- Estado: controles locales observados; OCI, GitHub Secrets y ACL Tailscale NO_VERIFICADOS

## Controles observados

- SSH conectó con host key checking habilitado, BatchMode y timeout; no se imprimió ni copió la clave privada.
- sshd -T informa PermitRootLogin no, PubkeyAuthentication yes, PasswordAuthentication no y KbdInteractiveAuthentication no.
- AllowTcpForwarding yes y X11Forwarding yes en sshd -T; controles específicos por usuario/llave no examinados.
- Docker requiere sudo -n para lecturas; no se cambiaron grupos ni permisos.
- UFW no está instalado; nftables/iptables se consultó sin modificarlo.
- 80/443 están publicados por Caddy; TLS valida. RabbitMQ está enlazado a loopback.
- /etc/g6-inventory/runtime.env tiene modo 640; su contenido no se leyó. No existen directorios runtime de Gateway, Catalog y Taxonomy.
- Volúmenes no inspeccionados por dentro. No se almacenan en este informe credenciales, tokens, archivos runtime o mensajes.
- La VM OCI ID se obtuvo del IMDS; no se consultaron tenancy, NSG ni Security Lists.

## Riesgos y pendientes

1. tailscaled está activo y ss muestra UDP 41641. ACL, dispositivos autorizados y alcance externo UDP NO_VERIFICADO; no se concluye que el puerto sea accesible desde Internet.
2. La política de forwarding SSH requiere confirmación del owner.
3. NSG/Security Lists no fueron consultadas; conectividad desde un origen no las sustituye.
4. No se comprobó existencia ni contenido de GitHub Actions Secrets.
5. PostgreSQL: configuración de aplicaciones, TCP, TLS, autenticación, identidad y readiness NO_VERIFICADOS.
6. No hay swap; no se observó presión de memoria. La política de capacidad al añadir servicios queda pendiente.

## Tratamiento

No se leyeron valores de .env/runtime.env, contraseñas, tokens, cookies Erlang o mensajes. No se calcularon hashes de secretos. La evidencia conserva solo metadatos, resultados sanitizados y hashes de artefactos no secretos.
