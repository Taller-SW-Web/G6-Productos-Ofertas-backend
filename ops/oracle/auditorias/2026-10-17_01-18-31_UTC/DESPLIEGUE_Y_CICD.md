# Despliegue y CI/CD

## Trazabilidad

- ID: G6-ORACLE-20261017T011831Z
- Inicio UTC: 2026-10-17T01:18:31Z · Lima: 2026-10-16T20:18:31-05:00
- Fin de observación UTC: 2026-10-17T01:32:03Z · Lima: 2026-10-16T20:32:03-05:00
- Hostname: g6-po-vcn · IP: 157.137.205.218
- VM OCI: ocid1.instance.oc1.sa-bogota-1.anrgcljrdootsrackizlzau3lpu7dgpcljyhkropav75k65zran5iqlghxba
- Usuario SSH: ubuntu
- Rama: castilla · SHA auditado: 741258510bf5350f172c165fb061643d49db439b
- SHA de master: 9cd6edcef6039ebdf9f1f94c9e991b0358ffc9de
- Archivo: DESPLIEGUE_Y_CICD.md
- Alcance: comparación de artefactos backend, Oracle, configuración privada e issues
- Estado: archivos/versions contrastados; secrets y runs de Actions NO_VERIFICADOS

## Comparación de artefactos

Los SHA-256 instalados se compararon con el contenido del HEAD de origin/master y checkout castilla.

| Artefacto | Master 9cd6edc | Castilla 7412585 | Instalado en Oracle | Resultado |
|---|---|---|---|---|
| services.psv | Hash 259e53249ffd0764231f4bf5a96a85c061b1464895ec095df61b4cae9b0bba57; cuatro servicios true | Mismo hash; cuatro servicios true | Hash c25ce00254895d845a17cf014f7d86e7170cbad2bf572f8ec2f9ea5de212ba9c; solo Inventory true | Manifiesto remoto anterior a master |
| service-registry.sh | Hash ab95405450a9b4f9f5527381d444c7de6fa58ddc64afb12ae7fbe9aa3dab4a30 | Igual | Hash idéntico | Coincide |
| deploy-g6-service.sh | Hash f06b0fb48ed4d08a26114beae339aea809ba3b762880907168b7281dd6acd40; ejecutor 4 | Mismo hash y versión 4 | Instalado como deploy-g6-service; hash faf2282bfb96b5b87606f655e8d3357ec7f87a824cd18abb300983a4b37525a6; --version informa ejecutor=3 registro=2 | Ejecutora remota anterior a master |
| docker-compose.service.yml | Hash bb2fdefa5f25744aa7f7d7c151d42a80559fb689bdfd1ba0a35da13299551180 | Igual | Mismo hash en /opt/g6-productos-ofertas/shared/docker-compose.service.yml | Coincide |
| docker-compose.service.http.yml | Hash 6f404818256f6fb4639faf64466f4400845190c2f07cd950cd7928075dbeb5fe | Igual | No instalado; g6-http ausente | Artefacto HTTP no instalado |
| docker-compose.inventory.http.yml | Hash 6658c2157b9bdf246ff1607fbc1338f973e5f28486b3cc0e4ee89b1b0b9b50c | Igual | No instalado; g6-http ausente | Overlay Inventory no instalado |
| cd-services-oracle.yml | workflow_dispatch únicamente | Igual | No es un archivo instalado en VM | El workflow vigente en ambas ramas es manual |

El wrapper /usr/local/sbin/deploy-inventory-svc existe. Su hash coincide con ops/oracle/deploy-inventory-svc.sh del checkout. El Compose base instalado de Inventory tiene hash 1fec0615e1c229c5bcbe41a02eceda2feaedf2d14e46454d12774ac4e4250879; no se encontró un archivo base docker-compose.inventory.yml versionado bajo ops/oracle para compararlo. El directorio /var/lib/g6-inventory está vacío y no tiene active-image ni previous-image.

La instalación remota coincide parcialmente con master: service-registry.sh y docker-compose.service.yml sí coinciden; services.psv y deploy-g6-service son anteriores, y los dos overlays HTTP no están instalados. El ejecutor v4 y el manifiesto con cuatro servicios habilitados existen en GitHub, no en Oracle. No se inició ni detuvo ningún servicio.

## GitHub e issues

- origin/master: 9cd6edcef6039ebdf9f1f94c9e991b0358ffc9de, exactamente el merge reportado de PR #117; no hay commits posteriores en master al corte.
- origin/castilla y checkout: 741258510bf5350f172c165fb061643d49db439b; es el parent de merge y su código de CD quedó integrado en master.
- #8 INFRA-002 OPEN; el cuerpo limita la habilitación inicial a Inventory y un comentario dice expresamente que no se amplía la allowlist y que la activación sigue siendo explícita.
- #20 HTTPS OPEN; DNS/TLS/endpoint se verificaron, pero falta proxy a Gateway.
- #110 composición Oracle OPEN.
- #111 liberación integrada OPEN; sus gates de autorización, ventana, SHA, secrets, readiness y rollback siguen siendo requisitos.

El código de la rama se encuentra en master por PR #117, pero el estado OPEN y el criterio/comentario de #8 contradicen la allowlist de cuatro servicios del manifiesto vigente. No se infiere autorización para liberar los tres servicios añadidos; el owner debe resolver esta contradicción antes del despliegue.

## Bloqueos para despliegue manual y CD

1. Resolver con el owner el alcance de INFRA-002: master habilita cuatro servicios, pero el issue abierto y su comentario conservan Inventory como alcance inicial.
2. Alinear Oracle con el artefacto vigente autorizado: revisar y aprobar manifiesto, ejecutor v4 y overlays antes de instalarlos.
3. Crear configuración privada aprobada para Gateway/Catalog/Taxonomy y verificar permisos, CA, TCP, TLS, autenticación e identidad PostgreSQL sin exponer valores.
4. Preparar g6-http y el reverse proxy a Gateway con cambio operativo autorizado y rollback.
5. Verificar CI exitosa para el SHA exacto de master, secrets de Actions, operador, ventana y gates de #111.
6. Acreditar rollback de cada servicio sin alterar Inventory.

## PostgreSQL/Supabase y rollback

| Nivel de verificación | Gateway | Catalog | Taxonomy | Inventory |
|---|---|---|---|---|
| Configuración privada presente | NO; directorio ausente | NO; directorio ausente | NO; directorio ausente | SÍ, runtime.env existe; contenido no leído |
| Conectividad TCP | NO_VERIFICADO | NO_VERIFICADO | NO_VERIFICADO | NO_VERIFICADO |
| TLS validado | NO_VERIFICADO | NO_VERIFICADO | NO_VERIFICADO | NO_VERIFICADO |
| Autenticación | NO_VERIFICADO | NO_VERIFICADO | NO_VERIFICADO | NO_VERIFICADO |
| Identidad PostgreSQL | NO_VERIFICADO | NO_VERIFICADO | NO_VERIFICADO | NO_VERIFICADO |
| Readiness funcional | NO_VERIFICADO | NO_VERIFICADO | NO_VERIFICADO | NO_VERIFICADO |

No se leyeron referencias CA de runtime.env ni se consultó Supabase. No se ejecutó SQL. No hay contenedor Inventory activo. La existencia del archivo runtime de Inventory no prueba que sus valores sean correctos.

El ejecutor genérico v3 está instalado, pero el directorio de estado de Inventory no tiene registros active-image/previous-image. No hay estados de imagen ni rollback real que comprobar para los otros servicios. Existencia de mecanismo en código no equivale a rollback probado.

El workflow de master y castilla requiere workflow_dispatch manual; no hay disparador workflow_run en el HEAD vigente. Una automatización selectiva futura requiere decisión y revisión autorizadas sobre disparador, allowlist, CI del mismo SHA, selección, historial de Deployments, concurrencia, rollback, secretos y permisos. No se ejecutaron workflows ni despliegues.
