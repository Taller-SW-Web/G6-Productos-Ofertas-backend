# Preparación Oracle G6 para Hito 3

Referencia: auditoría `G6-ORACLE-20261017T011831Z`. Rama de trabajo: `castilla`.

## Estado

La infraestructura base está parcialmente preparada para nueve componentes. La elegibilidad del manifiesto y los cambios de Compose siguen pendientes de revisión e integración. Ningún microservicio fue desplegado. La preparación de Oracle no equivale a readiness funcional ni a autorización de liberación.

| Fase | Estado | Evidencia y pendientes |
|---|---|---|
| A. Autorización, preflight y respaldo | COMPLETADO | Autorización de Marco registrada en #8. Respaldo privado recuperable descrito abajo. |
| B. Ejecutor y preparación de nueve servicios | PARCIAL | Ejecutor v4 y registro integrado v2 revisados instalados; Oracle conserva su allowlist integrada de cuatro servicios. Cambios para nueve preparados en `castilla`, pendientes de PR/CI/revisión/integración. |
| C. Redes y directorios | PARCIAL | `g6-http` creada; `g6-edge` conservada. Directorios/estados independientes preparados. No hay miembros de aplicaciones desplegados. RabbitMQ sin cambios y sin servicios G6 que requieran AMQP identificados en el código revisado. |
| D. Supabase y runtime | PARCIAL | CA pública Supabase instalada en host y verificada; no hay certificados montados en servicios ni credenciales runtime configuradas. Catálogo y Taxonomía quedan `PENDIENTE_CREDENCIAL`. Gateway queda pendiente de upstreams/runtime. |
| E. Caddy y HTTPS | PARCIAL | Caddy y certificado existentes conservados. Caddyfile sin cambios; Gateway no está desplegado ni funcionalmente listo, así que sigue pendiente cambiar el 503 provisional. |
| F. Tailscale y SSH | PARCIAL | Clave SSH de despliegue existente restringida y validada. `tailscaled` responde `NeedsLogin`; requiere que Marco confirme/inicie sesión en la tailnet autorizada y que Actions pueda acceder por esa ruta privada. No se abrió SSH público adicional. |
| G. Publicación manual | PENDIENTE | No hay autorización de liberación individual para ningún servicio. No se ejecutó CD ni migraciones. |
| H. Entrega a agente B | PENDIENTE | No activar CD automático hasta completar los gates indicados al final. |

## Actualización de continuación (2026-10-17 02:25 UTC / 2026-10-16 21:25 Lima)

- Las dos ejecuciones CI del PR #122 sobre `7672b4711e7680196cf59be5d4209a77175b4a0d` terminaron SUCCESS. El log confirma que `ops/oracle/tests/deploy-g6-service.test.sh` se ejecutó, y que sus comprobaciones de rollback/aislamiento reportaron PASS. La suite no fue omitida.
- `master` avanzó a `950fd20499d67c6f265dcde4a40971f4c4fb6180` (PR #118). Se sincronizó `castilla` mediante merge no destructivo en `b2fb417cebbffeabd055310d8ec41e4ffbc5aae7`; no se hizo rebase. PR #122 permanece draft, sin review decision/aprobación. Las CI del nuevo head están pendientes/en curso en esta actualización.
- Oracle sigue en Docker 29.9.0 / Compose 5.6.0, ejecutor `ejecutor=4 registro=2`, con allowlist integrada de cuatro servicios. Caddy está running; RabbitMQ está healthy; no hay contenedores de aplicación. `g6-http` permanece vacía, `g6-edge` tiene solo `g6-caddy`, y `g6-po_g6_backend` tiene solo `g6-po-rabbitmq-1`. Esto confirma separación de redes, pero no prueba conectividad DNS/HTTP entre aplicaciones que aún no están desplegadas.
- Los ocho directorios nuevos `/etc/g6-<servicio>` y `/var/lib/g6-productos-ofertas/<servicio>` existen con modos 0750 y 0700 respectivamente. API Gateway, Catalog y Taxonomy no tienen `runtime.env`; los otros cinco archivos preparados son 0640 y vacíos. Inventory mantiene `/etc/g6-inventory/runtime.env` (root:g6-inventory-deploy, 0640) y `/var/lib/g6-inventory` (inventory-deploy:g6-inventory-deploy, 0700), sin leer el contenido runtime.
- En el host, `docker compose config --quiet` pasó para el Compose genérico instalado aplicado a los ocho servicios no-Inventory, y para el Compose/overlay instalado de Inventory. El Compose genérico instalado no incluye todavía el montaje CA de solo lectura, y el registro sigue apuntando Gateway al Compose genérico heredado. El Compose dedicado Gateway (`g6-edge` + overlay `g6-http`) del PR no se instaló antes de aprobación/integración; su compatibilidad se validó en CI Linux del commit anterior. No ejecutar Gateway hasta instalarlo desde el commit integrado y configurar upstreams listos.
- SHA-256 observados en Oracle a `2026-10-17 02:25:09 UTC`: ejecutor v4 `f06b0fb48ed4d08a26114beeae339aea809ba3b762880907168b7281dd6acd40`; `service-registry.sh` `ab95405450a9b4f9f5527381d444c7de6fa58ddc64afb12ae7fbe9aa3dab4a30`; allowlist integrada `services.psv` `259e53249ffd0764231f4bf5a96a85c061b1464895ec095df61b4cae9b0bba57`; Compose genérico instalado `bb2fdefa5f25744aa7f7d7c151d42a80559fb689bdfd1ba0a35da13299551180`; overlay genérico `6f404818256f6fb4639faf64466f4400845190c2f07cd950cd7928075dbeb5fe`; Compose Inventory `1fec0615e1c229c5bcbe41a02eceda2feaedf2d14e46454d12774ac4e4250879`; overlay Inventory `6658c2157b9bdf246ff1607f7bc1338f973e5f28486b3cc0e4ee89b1b0b9b50c`. Estos hashes confirman que el registro de nueve y el Compose candidate siguen pendientes en Oracle.
- PostgreSQL sigue sin prueba de conectividad/autenticación/rol/permisos: no se proporcionaron credenciales runtime para Catalog/Taxonomy. La CA permanece en host como root:root 0444 y aún no está montada en containers.
- Tailscale continúa `NeedsLogin` y no tiene IP. Se requiere que Marco identifique/confirme la tailnet aprobada y autentique/apruebe el nodo Oracle desde esa tailnet; la autenticación no se ejecutó. Luego el administrador del repositorio debe provisionar la integración de Actions con identidad tagged/ephemeral autorizada y cambiar el destino SSH al MagicDNS/IP privada. Mantener cerrado el acceso de runners por SSH público.

### Configuración PostgreSQL requerida, sin secretos

- `catalog-svc` usa `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGSSLMODE=verify-full`, `PGSSLROOTCERT=/run/g6-certs/supabase-server-root.crt`, `G6_DATABASE_SCHEMA=catalog`, `G6_EXPECTED_ROLE` (`catalog_dev_login` o `catalog_app`) y `G6_CONNECTION_MODE` (`session` o `direct`). `G6_CONNECT_HOST` es opcional para el endpoint de transporte; TLS valida el nombre de `PGHOST`.
- `taxonomy-svc` recibe estos datos por `DATABASE_URL` (`sslmode=verify-full`, `sslrootcert=/run/g6-certs/supabase-server-root.crt`, `currentSchema=taxonomy`) y runtime `G6_EXPECTED_ROLE` (`taxonomy_dev_login` o `taxonomy_app`) más `G6_CONNECTION_MODE` (`session` o `direct`).
- En ambos casos el código valida certificado y hostname y luego `verifyIdentity()` comprueba usuario/base/schema, que el rol no tenga superuser/BYPASSRLS/CREATEROLE/CREATEDB y que no sea miembro del owner del schema. Esta validación runtime no se pudo ejecutar porque faltan credenciales y endpoint aprobados. No pedir ni pegar contraseñas en el chat; el operador debe cargarlas directamente en los archivos privados protegidos y coordinar solo el resultado sanitizado.

### Acceso privado para GitHub Actions

El repositorio tiene los seis secretos `ORACLE_HOST`, `ORACLE_USER`, `ORACLE_SSH_PRIVATE_KEY`, `ORACLE_SSH_KNOWN_HOSTS`, `ORACLE_GHCR_USERNAME` y `ORACLE_GHCR_TOKEN`; la lista no incluye integración Tailscale. No se inspeccionaron sus valores. El workflow actual aún no incorpora un cliente Tailscale; por tanto, no usar su dispatch para desplegar hasta completar el acceso privado y cambiar `ORACLE_HOST` a MagicDNS/IP privada. No permitir runners por SSH público.

Acción humana requerida: Marco debe identificar/confirmar la tailnet autorizada; el administrador/owner de esa tailnet debe autenticar y aprobar el nodo Oracle (por ejemplo, iniciando `sudo tailscale up`, abriendo el enlace de autenticación en la cuenta organizacional correcta y aprobando el dispositivo en Admin Console). Después, Marco/el administrador de GitHub debe configurar la federación/OAuth de Actions, un tag y una política ACL/SSH de mínimo acceso compatibles con esa tailnet, provisionar la autenticación de Actions sin poner claves en Git, y probar `connectivity-probe` por el nombre privado. No se eligió tailnet, tag ni política en esta misión.

Referencias operativas actuales: [Tailscale: configurar servidores](https://tailscale.com/kb/1245/set-up-servers), [Tailscale GitHub Action](https://tailscale.com/docs/integrations/github/github-action) y [conectar workflows de GitHub con infraestructura privada](https://tailscale.com/kb/1586/secure-github-runners).

### Estado operativo de los nueve componentes

`PREPARADO` significa infraestructura host/directorios/Compose genérico comprobados; no acredita readiness funcional. Ninguno está listo para liberar o desplegado.

| Servicio | Estado | Pendiente específico |
|---|---|---|
| api-gateway | INFRAESTRUCTURA_PREPARADA | PR integrado, Compose dedicado/CA, upstreams reales, health/readiness y Caddy. |
| catalog-svc | INFRAESTRUCTURA_PREPARADA | PR integrado, credential PostgreSQL mínimo privilegio, TLS verify-full y prueba de rol/permisos. |
| pricing-svc | INFRAESTRUCTURA_PREPARADA | Readiness funcional; `/health` solo acredita liveness. |
| price-audit-svc | INFRAESTRUCTURA_PREPARADA | Readiness funcional; `/health` solo acredita liveness. |
| promotions-svc | INFRAESTRUCTURA_PREPARADA | Readiness funcional; `/health` solo acredita liveness. |
| inventory-svc | INFRAESTRUCTURA_PREPARADA | Configuración heredada preservada; readiness funcional no acreditada. |
| taxonomy-svc | INFRAESTRUCTURA_PREPARADA | PR integrado, credential PostgreSQL mínimo privilegio, TLS verify-full y prueba de rol/permisos. |
| combos-svc | INFRAESTRUCTURA_PREPARADA | Readiness funcional; `/health` solo acredita liveness. |
| bulk-svc | INFRAESTRUCTURA_PREPARADA | Readiness funcional; `/health` solo acredita liveness. |

## Registro de operaciones en Oracle

Tiempos de las operaciones de Oracle entre `2026-10-17 01:58 UTC` y `2026-10-17 02:13 UTC` (Lima: `2026-10-16 20:58`–`21:13`, UTC−5). Las horas exactas de respaldo y autorización se conservaron en sus metadatos y en el issue #8.

- `2026-10-17 02:00:10 UTC` / `2026-10-16 21:00:10 Lima`: respaldo en `/var/backups/g6-productos-ofertas/hito3-oracle-20261017T020010Z`, dueño root, modo 0700; archivos y metadatos con acceso restringido. Incluye ejecutor anterior, registros, Compose de servicios, Compose/Caddyfile existentes y archivos de despliegue de Inventory. `SHA256SUMS` pasó `sha256sum -c`; se compararon contenidos con los originales. `authorized_keys` tuvo respaldo separado antes de restringir la clave de Actions.
- Se instaló `/usr/local/lib/g6-productos-ofertas/deploy-g6-service` v4 y el soporte/registro revisado desde el commit `9cd6edcef6039ebdf9f1f94c9e991b0358ffc9de`. Hashes de fuente contrastados con Git; versión reportada `ejecutor=4 registro=2`. Los archivos instalados son root-owned con modos restringidos.
- Se verificó el registro del host con los cuatro servicios autorizados ya integrados. **No se reemplazó `services.psv` por el candidato de nueve** antes de su aprobación e integración.
- Se creó Docker bridge `g6-http` (`internal=false`, `attachable=false`, sin opciones personalizadas), sin contenedores conectados. `g6-edge` permanece intacta y con Caddy como único miembro. No se conectó RabbitMQ a ninguna red nueva.
- Se prepararon grupos y directorios privados por servicio, con estado separado. Inventory conserva `/etc/g6-inventory/runtime.env`, `/var/lib/g6-inventory`, su wrapper y Compose legado; no se reinició ni modificó RabbitMQ.
- CA Supabase `Supabase Root 2021 CA` copiada a `/etc/g6-postgres/supabase-server-root.crt`, root:root, modo 0444; hash SHA-256 contrastado con el archivo fuente y certificado parseable con OpenSSL. El montaje de solo lectura queda incluido en el Compose candidato, no instalado hasta revisión.
- Se añadieron opciones de restricción a la clave pública preexistente `github-actions-g6-cd` sin sustituir su fingerprint: sin port-forwarding, agent-forwarding, X11 ni PTY. La autenticación sigue comprobada por la ruta pública existente; no se amplió el firewall. El acceso privado Tailscale no está listo.

Versiones observadas durante el preflight: Ubuntu 24.04, Docker 29.9.0, Compose 5.6.0, Caddy 2.11.6 y RabbitMQ 4.2.9-management. No se cambiaron versiones ni se reiniciaron esos servicios.

## Configuración y readiness por servicio

Los nueve tienen rutas de estado/runtime y parámetros de Compose definidos en el manifiesto candidato. El `runtime.env` se creó vacío solo para servicios cuyo código actual no exige secretos/configuración externa. No se inventaron endpoints, credenciales ni variables de aplicación.

| Servicio | Puerto | Situación runtime y readiness |
|---|---:|---|
| api-gateway | 3000 | Runtime/upstreams no configurados; readiness depende de upstreams disponibles. PENDIENTE. |
| catalog-svc | 3001 | Requiere conexión PostgreSQL segura y credencial runtime de mínimo privilegio. PENDIENTE_CREDENCIAL. |
| pricing-svc | 3002 | Archivo runtime vacío; solo `/health` identificado. Readiness funcional no acreditada. |
| price-audit-svc | 3003 | Archivo runtime vacío; solo `/health` identificado. Readiness funcional no acreditada. |
| promotions-svc | 3004 | Archivo runtime vacío; solo `/health` identificado. Readiness funcional no acreditada. |
| inventory-svc | 3005 | Configuración heredada preservada. No se cambió la implementación ni se atribuye readiness funcional. |
| taxonomy-svc | 3006 | Requiere conexión PostgreSQL segura y credencial runtime de mínimo privilegio. PENDIENTE_CREDENCIAL. |
| combos-svc | 3007 | Archivo runtime vacío; solo `/health` identificado. Readiness funcional no acreditada. |
| bulk-svc | 3008 | Archivo runtime vacío; solo `/health` identificado. Readiness funcional no acreditada. |

La revisión del código de los nueve servicios no identificó consumidores/productores RabbitMQ actuales; por ello ningún servicio fue conectado a la red del broker. Esto deberá revisarse al integrar nuevas implementaciones que declaren dependencia AMQP.

## Validaciones realizadas

- Respaldo: `sha256sum -c` PASS y comparación exacta de archivos respaldados.
- Oracle: `ejecutor=4 registro=2`, hash de artefactos contrastado, `g6-http` verificada, permisos de directorios y key restrictions verificados. RabbitMQ/Caddy se inspeccionaron sin reinicio.
- Local: `git diff --check` PASS; `select-cd-services.test.sh` PASS para los nueve; `publish-isolation.test.sh` PASS.
- `deploy-g6-service.test.sh`: **NO PASS**. En Windows/Git Bash, `docker compose config` resolvió mal una ruta temporal del archivo de Inventory y la prueba terminó en `Compose de Inventory con g6-http inválido`. Requiere repetición en Linux/CI; no se declara validación completa.
- No se ejecutaron migraciones, consultas de escritura, CD, pulls de imágenes ni despliegues. No se validó conectividad autenticada Supabase, health/readiness real de aplicaciones ni TLS extremo a extremo.

## Rollback

- Restaurar archivos privilegiados desde `/var/backups/g6-productos-ofertas/hito3-oracle-20261017T020010Z` solo después de verificar hashes/permisos y detener la operación correspondiente. El respaldo no debe exponerse al usuario de despliegue.
- La restricción SSH se revierte restaurando el `authorized_keys` respaldado tras una revisión de acceso; comparar fingerprint original antes de instalar.
- No eliminar `g6-http` si aparece algún consumidor. Si aún está vacía, se puede retirar únicamente tras verificar que no hay endpoints/conexiones; no ejecutar prune.
- Mantener `g6-edge`, contenedores y volúmenes de Caddy/RabbitMQ/Inventory. No utilizar `down -v`, prune ni cambios globales.
- Cada servicio conserva su propio `active-image`, `previous-image` y estado. No se cambiaron imágenes ni esos marcadores.

## Prerrequisitos antes de agente B

1. Revisar e integrar el PR de elegibilidad de nueve servicios desde `castilla`; confirmar CI exitosa, incluyendo la repetición de la prueba integral en Linux. El manifiesto de Oracle debe actualizarse manualmente desde el commit exacto integrado, con respaldo y verificación de hash.
2. Marco debe iniciar sesión en la tailnet autorizada o coordinar la autenticación aprobada. Configurar el host de Actions por Tailscale y confirmar que runners autorizados alcanzan SSH privado; no abrir puerto 22 al público para GitHub-hosted runners.
3. El operador debe proporcionar credenciales runtime dedicadas de mínimo privilegio y endpoint de conexión Supabase para Catalog/Taxonomy, confirmar TLS `verify-full` con la CA instalada, y validar conectividad, autenticación, rol y permisos sin imprimir secretos. Ningún valor se guardó o consultó en este lote.
4. Proveer y validar config de Gateway según interfaces integradas y servicios realmente listos; mantener Caddy en su estado actual hasta que Gateway tenga health, readiness y HTTPS verificables.
5. Obtener autorización de liberación por cada servicio con SHA/CI aprobado, runtime completo, imagen disponible, readiness funcional y rollback revisado. La autorización general de infraestructura no sirve como autorización de despliegue.
6. El agente B puede activar CD automático solo después de acordar y revisar explícitamente ese cambio. Esta misión no lo habilitó.
