# Caddy, DNS y HTTPS

## Trazabilidad

- ID: G6-ORACLE-20261017T011831Z
- Inicio UTC: 2026-10-17T01:18:31Z · Lima: 2026-10-16T20:18:31-05:00
- Fin de observación UTC: 2026-10-17T01:32:03Z · Lima: 2026-10-16T20:32:03-05:00
- Hostname: g6-po-vcn · IP: 157.137.205.218
- VM OCI: ocid1.instance.oc1.sa-bogota-1.anrgcljrdootsrackizlzau3lpu7dgpcljyhkropav75k65zran5iqlghxba
- Usuario SSH: ubuntu
- Rama: castilla · SHA auditado: 741258510bf5350f172c165fb061643d49db439b
- SHA de master: 9cd6edcef6039ebdf9f1f94c9e991b0358ffc9de
- Archivo: CADDY_Y_HTTPS.md
- Alcance: Caddy, DNS, certificado y endpoint HTTPS
- Estado: dominio/TLS/respuesta verificados; upstream y ciclo de renovación NO_VERIFICADO

## Observaciones

Contenedor y configuración observados a 2026-10-17T01:19:23Z; prueba pública aproximadamente a las 01:19:57Z.

- g6-caddy activo, imagen caddy:2.11.6-alpine, red g6-edge.
- Caddyfile: /opt/g6-productos-ofertas/caddy/conf/Caddyfile, bind read-only.
- Dominio: g6-productos-ofertas.duckdns.org.
- La configuración responde texto fijo 503: “Servicio pendiente: API Gateway G6 aún no está desplegado.” No hay reverse_proxy ni upstream.
- DNS A resuelve a 157.137.205.218.
- HTTPS respondió HTTP 503 con Server: Caddy.
- curl mantuvo verificación TLS predeterminada y reportó certificate_verify_result=0.
- Certificado X.509: CN del dominio; Let's Encrypt, emisor YE1; válido 2026-10-16T14:50:42Z a 2027-01-14T14:50:41Z.
- Huella SHA-256: E9:F2:01:F3:AB:FA:0D:C7:EB:5C:AA:35:72:96:9B:50:BC:89:84:C5:CB:91:52:AF:E5:CD:A9:6F:A4:22:3C:A1.
- La renovación automática es compatible con Caddy y su configuración, pero no se inspeccionó un ciclo de renovación; estado NO_VERIFICADO.
- Caddy no tiene healthcheck Docker.

## Interpretación

Caddy y TLS funcionan para el dominio. El 503 coincide con la respuesta explícita configurada y la ausencia del Gateway; no indica por sí solo una falla de Caddy. El proxy hacia Gateway y la conectividad interna no existen. No se revisaron volúmenes privados, credenciales DNS, NSG o Security Lists, y no se modificó Caddy ni DNS.
