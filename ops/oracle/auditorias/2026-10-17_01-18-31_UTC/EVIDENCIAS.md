# Evidencias sanitizadas

## Trazabilidad

- ID: G6-ORACLE-20261017T011831Z
- Inicio UTC: 2026-10-17T01:18:31Z · Lima: 2026-10-16T20:18:31-05:00
- Fin de observación UTC: 2026-10-17T01:32:03Z · Lima: 2026-10-16T20:32:03-05:00
- Hostname: g6-po-vcn · IP: 157.137.205.218
- VM OCI: ocid1.instance.oc1.sa-bogota-1.anrgcljrdootsrackizlzau3lpu7dgpcljyhkropav75k65zran5iqlghxba
- Usuario SSH: ubuntu
- Rama: castilla · SHA auditado: 741258510bf5350f172c165fb061643d49db439b
- SHA de master: 9cd6edcef6039ebdf9f1f94c9e991b0358ffc9de
- Archivo: EVIDENCIAS.md
- Alcance: comandos de solo lectura, finalidad y resultados sanitizados
- Estado: evidencia recogida; no se guardan salidas completas ni secretos

## Registro de consultas

| Hora UTC | Comando o grupo | Propósito | Resultado sanitizado |
|---|---|---|---|
| 01:18–01:19 | SSH con BatchMode, ConnectTimeout=10, StrictHostKeyChecking=yes; date, hostnamectl, os-release, uname, nproc, free, df, uptime, timedatectl | Acceso y capacidad | SSH_OK; g6-po-vcn; Ubuntu 24.04.5; 4 CPU; 11 GiB RAM; 0 swap; 41 GiB libres; reloj UTC sincronizado |
| 01:18:54 | sudo -n docker version/compose version/ps -a/inspect/network ls/inspect; ss -lntup | Docker, contenedores, redes y puertos | Engine 29.9.0, Compose 5.6.0; 2 contenedores; g6-http ausente |
| 01:18:54 | sudo -n nft list ruleset; iptables -S; ufw status; ip -brief address; ip route | Firewall local y rutas | UFW ausente; reglas observadas sin cambio |
| 01:19:23 | stat/find/sha256sum de rutas; grep filtrado del Caddyfile; rabbitmqctl list_vhosts/exchanges/queues/bindings/connections | Instalación, proxy y topología Rabbit | Caddy 503 estático; configs target ausentes; vhost y topología presentes |
| 01:20:13 | deploy-g6-service --version; sha256sum artefactos; openssl x509 -noout; rabbitmq-diagnostics y conteos | Versión instalada, certificado y broker | ejecutor=3 registro=2; TLS LE válido a 2027-01-14; 11 colas, 68 bindings, 0 consumidores/conexiones |
| 01:20:37 | GET IMDS con campos id/shape/region seleccionados; docker system df; ls/find de estado | Identidad y capacidad de despliegue | VM ID y shape verificados; estado Inventory vacío; sin lectura de runtime |
| 01:19:57–01:24:14 | Resolve-DnsName; curl -I y curl de certificado con validación habilitada; conexiones TCP con timeout | DNS, HTTPS y accesibilidad | DNS a IP auditada; TLS verify=0; 503 de Caddy; 22/80/443 accesibles; puertos de apps/Rabbit no |
| 01:23–01:24 | sshd -T filtrado; systemctl is-active tailscaled; docker images | Seguridad SSH e imágenes | root y autenticación por contraseña deshabilitados; Tailscale activo; sin imágenes de app G6 |
| 01:18–01:32 | git status/rev-parse/ls-remote/fetch/show/hash | Punta de master y comparación de instalación | castilla limpia al inicio; master=9cd6edc (merge #117); Oracle coincide en registro/Compose, pero manifiesto/ejecutor son anteriores y overlays faltan |
| 01:28–01:32 | git ls-remote/fetch master; GitHub API: issues, comentarios #8/#20, commit #117 y compare | Confirmar punta remota y criterios de INFRA-002/HTTPS | master coincide exactamente con el merge #117; workflow manual y allowlist de master contrastados; issue #8 abierto y su comentario pide no ampliar allowlist |

La consulta inicial a Docker sin sudo -n devolvió permiso denegado; se repitió con sudo -n y tuvo éxito. El listado de proyectos Compose no se obtuvo por interpretación de fin de línea de la sesión; labels de docker inspect identificaron proyecto y servicio de ambos contenedores. El ref local origin/master estaba atrasado inicialmente; se contrastó contra git ls-remote y se actualizó con git fetch origin master antes de cerrar la comparación. No se fusionaron ramas ni se cambió el árbol de trabajo.

## Sanitización y límites

- No se guardan salidas completas de inspect, directorios, reglas o GitHub.
- No se leyeron .env/runtime.env, contraseñas, tokens, cookies Erlang o mensajes.
- No se calcularon hashes de archivos secretos ni se almacenaron logs con datos de acceso.
- No se ejecutaron pull/up/down/restart/rm/prune, despliegues, SQL, cambios de configuración, publicación/consumo AMQP ni workflows.
- No se consultaron NSG/Security Lists OCI ni GitHub Actions Secrets.
