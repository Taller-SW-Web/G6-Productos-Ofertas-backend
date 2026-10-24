# Hallazgos y riesgos

## Trazabilidad

- ID: G6-ORACLE-20261017T011831Z
- Inicio UTC: 2026-10-17T01:18:31Z · Lima: 2026-10-16T20:18:31-05:00
- Fin de observación UTC: 2026-10-17T01:32:03Z · Lima: 2026-10-16T20:32:03-05:00
- Hostname: g6-po-vcn · IP: 157.137.205.218
- VM OCI: ocid1.instance.oc1.sa-bogota-1.anrgcljrdootsrackizlzau3lpu7dgpcljyhkropav75k65zran5iqlghxba
- Usuario SSH: ubuntu
- Rama: castilla · SHA auditado: 741258510bf5350f172c165fb061643d49db439b
- SHA de master: 9cd6edcef6039ebdf9f1f94c9e991b0358ffc9de
- Archivo: HALLAZGOS.md
- Alcance: defectos confirmados, bloqueos y riesgos para el primer release HTTP
- Estado: 5 hallazgos P1, 2 P2, 1 P3; infraestructura sin cambios

## H-001 — P1 — Allowlist de master contradice INFRA-002 abierto

- Componente: registro de servicios Oracle / issue #8.
- Descripción: origin/master contiene cuatro servicios habilitados. El issue #8 permanece OPEN; su criterio indica Inventory como único servicio inicialmente habilitado y su comentario dice que no se amplía la allowlist y que la activación conserva su carácter explícito.
- Evidencia: services.psv en master 9cd6edc; cuerpo y comentario de #8; workflow_dispatch manual en master.
- Impacto: la habilitación de Gateway, Catalog y Taxonomy está presente en código, pero su autorización operativa no puede inferirse frente al criterio/comentario abierto. El bloqueo es específico de liberar esos servicios.
- Corrección: owner de INFRA-002 confirma o corrige por escrito el alcance del issue y el criterio para los cuatro servicios.
- Cierre: issue/decisión actualizado por el owner y allowlist coincide con el alcance autorizado.

## H-002 — P1 — Artefactos de despliegue Oracle anteriores al master vigente

- Componente: ejecutor, registro y overlays de Docker en Oracle.
- Descripción: Oracle tiene el manifiesto con Inventory únicamente y ejecutor v3. Master en 9cd6edc tiene cuatro servicios habilitados y ejecutor v4; los overlays HTTP versionados tampoco están instalados. El hash del registro y del Compose base sí coincide.
- Evidencia: SHA-256 remoto frente a master; ejecutor --version=3/registro=2; g6-http ausente.
- Impacto: la VM no puede usar la configuración/versiones del master vigente para los servicios nuevos; el flujo actual en Oracle refleja solo Inventory.
- Corrección: después de resolver H-001 y obtener aprobación operativa, preparar instalación revisable por checksum con rollback, sin afectar Inventory.
- Cierre: versión y hashes instalados coinciden con el artefacto autorizado; pruebas de configuración y rollback aprobadas, sin afirmar despliegue hasta ejecutarlo.

## H-003 — P1 — Servicios de aplicación ausentes

- Componente: Gateway, Catalog, Taxonomy e Inventory.
- Descripción: docker ps -a lista solo Caddy y RabbitMQ; no hay imágenes de aplicación G6 ni listeners en 3000, 3001, 3005 o 3006.
- Evidencia: docker ps -a, docker images, ss y pruebas TCP del auditor.
- Impacto: no existe API G6 operativa; health/readiness de aplicaciones NO_VERIFICADO.
- Corrección: liberar exclusivamente servicios autorizados cuando configuración, red, CI/CD, readiness y aprobación estén completos.
- Cierre: imagen/SHA y contenedor por servicio, health y readiness funcional evidenciados.

## H-004 — P1 — g6-http y upstream de Caddy ausentes

- Componente: redes Docker y HTTPS.
- Descripción: g6-http no existe; Caddy está solo en g6-edge. Caddyfile responde 503 y no configura reverse_proxy.
- Evidencia: docker network ls/inspect, Caddyfile filtrado, HTTPS público y TLS válido.
- Impacto: Caddy no puede enrutar a Gateway. El 503 es la respuesta configurada por ausencia de Gateway.
- Corrección: preparar red y proxy mediante cambio autorizado con rollback; preservar proyectos de Inventory/RabbitMQ.
- Cierre: alias/upstream, conectividad Caddy-Gateway y smoke HTTPS documentados sin exponer puertos internos.

## H-005 — P1 — Configuración privada de los servicios objetivo no existe

- Componente: Gateway, Catalog, Taxonomy y PostgreSQL/Supabase.
- Descripción: no existen /etc/g6-api-gateway, /etc/g6-catalog-svc ni /etc/g6-taxonomy-svc. Existe /etc/g6-inventory/runtime.env, que no fue leído.
- Evidencia: stat/find de rutas, Docker mounts y contenedores, observados a 01:19Z.
- Impacto: configuración de endpoints, CA y credenciales no acreditada. TCP, TLS, autenticación, identidad y readiness PostgreSQL quedan NO_VERIFICADOS.
- Corrección: preparar referencias privadas por el proceso autorizado, con permisos mínimos y CA verificable.
- Cierre: config privada presente y readiness funcional demostrada sin exponer valores.

## H-006 — P2 — Sin swap ante crecimiento de carga

- Componente: capacidad VM.
- Descripción: 0 swap; a la vez, cerca de 10 GiB de RAM disponibles, carga baja y 41 GiB libres en raíz. No se observó agotamiento.
- Evidencia: free, df, uptime y docker system df.
- Impacto: riesgo de OOM si crece la carga.
- Corrección: definir capacidad y límites por servicio antes de ampliar despliegues.
- Cierre: owner valida límites y comportamiento bajo presión, sin cambios en esta auditoría.

## H-007 — P2 — Rollback de servicios no acreditado

- Componente: estado y recuperación de imágenes.
- Descripción: /var/lib/g6-inventory está vacío, sin active-image ni previous-image; no hay aplicaciones desplegadas ni registros de imagen de las nuevas rutas.
- Evidencia: ls/find de estado de Inventory y lista completa de contenedores a 01:20Z.
- Impacto: el rollback para versiones activas/previas no puede comprobarse en runtime. El mecanismo en código no prueba una recuperación ensayada.
- Corrección: en una ventana operativa futura, verificar el procedimiento aprobado por servicio y conservar imágenes activas/previas sin tocar Inventory.
- Cierre: artefactos/SHA anterior y nuevo identificados, procedimiento de rollback validado y resultado registrado.

## H-008 — P3 — Listener Tailscale y forwarding requieren revisión del owner

- Componente: acceso administrativo.
- Descripción: tailscaled activo, UDP 41641 escuchando; sshd -T informa AllowTcpForwarding yes y X11Forwarding yes. No se comprobó acceso UDP externo ni ACL por llave.
- Evidencia: systemctl, ss, sshd -T y nftables.
- Impacto: propósito y exposición efectiva de esos controles no acreditados.
- Corrección: owner confirma necesidad, ACL y alcance OCI.
- Cierre: política autorizada documentada y conectividad probada desde orígenes aprobados.
