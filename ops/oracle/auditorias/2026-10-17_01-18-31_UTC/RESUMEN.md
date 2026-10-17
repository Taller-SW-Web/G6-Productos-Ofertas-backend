# Resumen ejecutivo

## Trazabilidad

- ID: G6-ORACLE-20261017T011831Z
- Inicio UTC: 2026-10-17T01:18:31Z · Lima: 2026-10-16T20:18:31-05:00
- Fin de observación UTC: 2026-10-17T01:32:03Z · Lima: 2026-10-16T20:32:03-05:00
- Hostname: g6-po-vcn · IP: 157.137.205.218
- VM OCI: ocid1.instance.oc1.sa-bogota-1.anrgcljrdootsrackizlzau3lpu7dgpcljyhkropav75k65zran5iqlghxba
- Usuario SSH: ubuntu
- Rama: castilla · SHA auditado: 741258510bf5350f172c165fb061643d49db439b
- SHA de master consultado: 9cd6edcef6039ebdf9f1f94c9e991b0358ffc9de
- Archivo: RESUMEN.md
- Alcance: auditoría de solo lectura de VM, Docker, red, TLS, RabbitMQ, instalación y CD
- Estado: auditoría completa con observaciones; release de Gateway, Catalog y Taxonomy no aprobado

## Dictamen

**APROBADO CON OBSERVACIONES** para la ejecución de la auditoría. La VM fue inspeccionada mediante SSH y contrastada con GitHub. La preparación observada no acredita autorización de despliegue.

## Estado real

La VM OCI está activa con Ubuntu 24.04.5 LTS, 4 CPU, cerca de 11 GiB de RAM, 10 GiB disponibles, sin swap y 41 GiB libres en la raíz. Carga baja y reloj UTC sincronizado al momento de inspección.

Solo hay dos contenedores: Caddy 2.11.6 y RabbitMQ 4.2.9-management. Caddy sirve HTTPS válido para el dominio y devuelve 503 con la respuesta configurada mientras falta Gateway. RabbitMQ está HEALTHY, conserva su volumen, tiene el vhost g6-productos-ofertas, 11 colas y 68 bindings; se observaron 0 mensajes, consumidores y conexiones.

Gateway, Catalog, Taxonomy e Inventory no están desplegados. No hay imágenes de aplicación G6. Existen g6-edge y la red separada de RabbitMQ; g6-http no existe. Desde el equipo auditor fueron alcanzables TCP 22, 80 y 443; los puertos de aplicación, AMQP y Management no lo fueron.

## GitHub y CD

El HEAD de master consultado coincide con el merge de PR #117: 9cd6edcef6039ebdf9f1f94c9e991b0358ffc9de. No hay commits posteriores en master al momento de la auditoría. El workflow vigente requiere workflow_dispatch manual y el registro de master habilita Gateway, Catalog, Inventory y Taxonomy.

Oracle no está sincronizado con ese master: mantiene ejecutor v3 y un manifiesto que habilita solo Inventory; master ya contiene ejecutor v4 y los cuatro servicios habilitados. La red g6-http y sus overlays tampoco están instalados. El issue #8 continúa OPEN y su cuerpo/comentario indican que no se amplió la allowlist y que el corte conserva activación explícita. Hay una contradicción entre esa instrucción y el registro vigente de master; no se atribuye autorización por la presencia del código. Los issues #20, #110 y #111 siguen OPEN.

## Bloqueantes y riesgos

- El registro de master habilita cuatro servicios, mientras que el issue #8 abierto y su comentario indican que no se amplió la allowlist.
- Oracle mantiene versiones anteriores del manifiesto y ejecutor frente al master vigente.
- No existen Gateway, Catalog, Taxonomy o Inventory en Docker.
- g6-http y el destino reverse_proxy hacia Gateway no existen.
- Faltan directorios runtime privados de Gateway, Catalog y Taxonomy.
- No se verificaron NSG/Security Lists, secretos de Actions, PostgreSQL autenticado ni readiness funcional.
- Sin swap, aunque no se observó presión de recursos.

## Siguiente acción recomendada

Marco y el owner de infraestructura deben resolver la contradicción de INFRA-002 y el alcance autorizado del registro vigente antes de liberar Gateway, Catalog o Taxonomy. Después, preparar y aprobar la actualización de archivos Oracle, configuración privada, red HTTP y proxy, preservando Inventory. Una liberación posterior requiere CI exitosa del SHA exacto de master, secretos disponibles, readiness PostgreSQL/TLS, rollback, ventana y aprobación conforme a #111.

## Hallazgos

P0: 0 · P1: 5 · P2: 2 · P3: 1. El detalle, evidencia y condición de cierre se encuentran en [HALLAZGOS.md](HALLAZGOS.md).
