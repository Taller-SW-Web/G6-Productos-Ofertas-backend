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
