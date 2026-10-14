# CD de servicios G6 en Oracle Cloud

El CD publica imágenes inmutables por SHA en GHCR y despliega mediante SSH restringido. El manifiesto declarativo `ops/oracle/services.psv`, leído sin ejecutarlo por `ops/oracle/service-registry.sh`, contiene exactamente los nueve componentes del monorepo, sus puertos, rutas, imágenes, contenedores, estados y archivos privados de runtime; **`inventory-svc` es el único habilitado**. Los ocho servicios restantes se rechazan tanto en la ejecución manual como en el host Oracle hasta que se preparen y autoricen expresamente.

## Estado y límites

- El PR #7 dejó instalado el comando SSH `/usr/local/sbin/deploy-inventory-svc` y el Compose `/opt/g6-productos-ofertas/inventory/docker-compose.inventory.yml`. La ruta de comando antigua `inventory-deploy <SHA de 40 caracteres>` continúa siendo aceptada.
- El ejecutor común solo recibe un identificador del registro y un SHA hexadecimal de 40 caracteres. Rutas, imagen, proyecto Compose, contenedor, puerto y directorio de estado salen de valores constantes del registro. No acepta shell, rutas, nombre de contenedor ni destino como argumentos.
- Cada servicio tiene un proyecto Compose, contenedor y directorio de estado propios. Las operaciones apuntan a un único servicio; no usan `down`, `--remove-orphans` ni cambian la configuración de RabbitMQ.
- El healthcheck confirma el proceso HTTP en `/health`. No acredita conectividad, credenciales o preparación de Supabase.
- No se ha desplegado en la VM ni configurado ningún secreto real como parte de este cambio.

## Controles de GitHub Actions

El workflow `CD servicios Oracle` solo procesa un `push` de `master` con CI exitoso del mismo repositorio. Descarta SHAs que ya no son la punta de `master`, vuelve a comprobar la vigencia antes de SSH y publica cada imagen con su SHA. La ejecución manual está limitada a `master`, exige un CI exitoso de `push` para ese mismo SHA y rechaza servicios deshabilitados.

El job de publicación cuenta con `packages: write`; los demás conservan solo lectura de contenidos y acciones. Antes de enviar el token de GHCR, Actions valida presencia de secretos, host SSH mediante `known_hosts` y autenticación con la clave restringida. El host valida el servicio, el SHA, la imagen actual, el healthcheck de Docker y HTTP; si la versión nueva falla, restaura solo el servicio elegido.

## Transición segura del wrapper de Inventario

El despliegue anterior debe permanecer disponible hasta completar todas las comprobaciones. Ejecuta estos pasos manualmente en Oracle como administrador. **No ejecutes `docker compose up`, `pull`, reinicios ni el comando de despliegue durante la instalación o verificación.**

### 1. Guardar una copia recuperable del mecanismo instalado

Comprueba primero la ruta y checksum actuales; la ruta del Compose debe seguir siendo la del PR #7:

```bash
sudo stat --format='%U:%G %a %n' /usr/local/sbin/deploy-inventory-svc /opt/g6-productos-ofertas/inventory/docker-compose.inventory.yml
sudo sha256sum /usr/local/sbin/deploy-inventory-svc
sudo install --directory --owner root --group root --mode 0700 /var/backups/g6-productos-ofertas
sudo cp --preserve=mode,ownership,timestamps /usr/local/sbin/deploy-inventory-svc /var/backups/g6-productos-ofertas/deploy-inventory-svc.pr7
sudo sha256sum /usr/local/sbin/deploy-inventory-svc /var/backups/g6-productos-ofertas/deploy-inventory-svc.pr7
```

Confirma que ambos checksums coincidan antes de seguir. No reemplaces ni muevas el Compose ni los archivos de `/etc/g6-inventory` o `/var/lib/g6-inventory`.

### 2. Instalar el registro y el ejecutor genérico en rutas nuevas

Desde el checkout revisado del PR:

```bash
sudo install --directory --owner root --group root --mode 0755 /usr/local/lib/g6-productos-ofertas
sudo install --owner root --group root --mode 0644 ops/oracle/service-registry.sh /usr/local/lib/g6-productos-ofertas/service-registry.sh
sudo install --owner root --group root --mode 0644 ops/oracle/services.psv /usr/local/lib/g6-productos-ofertas/services.psv
sudo install --owner root --group root --mode 0755 ops/oracle/deploy-g6-service.sh /usr/local/lib/g6-productos-ofertas/deploy-g6-service
sudo install --directory --owner root --group root --mode 0755 /opt/g6-productos-ofertas/shared
sudo install --owner root --group root --mode 0644 ops/oracle/docker-compose.service.yml /opt/g6-productos-ofertas/shared/docker-compose.service.yml
```

Antes de cambiar el wrapper, inspecciona que solo Inventario está habilitado y valida el Compose actual sin imprimir secretos ni cambiar contenedores:

```bash
sudo bash -c 'source /usr/local/lib/g6-productos-ofertas/service-registry.sh; g6_enabled_services_json'
sudo -u inventory-deploy test -r /usr/local/lib/g6-productos-ofertas/service-registry.sh
sudo -u inventory-deploy test -x /usr/local/lib/g6-productos-ofertas/deploy-g6-service
sudo -u inventory-deploy test -r /opt/g6-productos-ofertas/inventory/docker-compose.inventory.yml
sudo -u inventory-deploy test -r /etc/g6-inventory/runtime.env
sudo -u inventory-deploy env INVENTORY_IMAGE=ghcr.io/taller-sw-web/g6-productos-ofertas-backend/inventory-svc:SHA_DE_40_CARACTERES docker compose --file /opt/g6-productos-ofertas/inventory/docker-compose.inventory.yml --project-name g6-inventory config --quiet
```

La salida del registro debe ser exactamente `["inventory-svc"]`. Sustituye el marcador por un SHA real de imagen únicamente para validar la sintaxis de Compose; no uses `up` ni `pull`.

### 3. Cambiar el wrapper de forma reversible

Instala primero una copia temporal y confirma que apunta al ejecutor recién instalado. Después reemplaza el destino SSH antiguo mediante renombre atómico:

```bash
sudo install --owner root --group root --mode 0755 ops/oracle/deploy-inventory-svc.sh /usr/local/sbin/deploy-inventory-svc.new
sudo grep -F '/usr/local/lib/g6-productos-ofertas/deploy-g6-service' /usr/local/sbin/deploy-inventory-svc.new
sudo mv --no-target-directory /usr/local/sbin/deploy-inventory-svc.new /usr/local/sbin/deploy-inventory-svc
```

Prueba el rechazo de un comando no autorizado localmente como el usuario SSH. El resultado esperado es un error `comando remoto no autorizado`; esta prueba no abre el despliegue ni toca Docker:

```bash
sudo -u inventory-deploy env SSH_ORIGINAL_COMMAND=connectivity-probe /usr/local/sbin/deploy-inventory-svc
```

Luego verifica la ruta SSH desde Actions con la prueba `connectivity-probe` del workflow. El comando histórico `inventory-deploy <SHA>` se acepta por el wrapper y conserva el Compose de `/opt/g6-productos-ofertas/inventory/docker-compose.inventory.yml`, el proyecto `g6-inventory`, el contenedor `g6-inventory-svc`, el puerto `127.0.0.1:3005`, `DATABASE_URL` de `/etc/g6-inventory/runtime.env` y el estado de `/var/lib/g6-inventory`.

Si la prueba local o de Actions falla, restaura el archivo previo (no reinicia ni despliega contenedores):

```bash
sudo install --owner root --group root --mode 0755 /var/backups/g6-productos-ofertas/deploy-inventory-svc.pr7 /usr/local/sbin/deploy-inventory-svc.restore
sudo mv --no-target-directory /usr/local/sbin/deploy-inventory-svc.restore /usr/local/sbin/deploy-inventory-svc
sudo sha256sum /usr/local/sbin/deploy-inventory-svc /var/backups/g6-productos-ofertas/deploy-inventory-svc.pr7
```

Los checksums deben coincidir con los anotados antes del cambio. Conserva la copia hasta que el wrapper nuevo y una ejecución normal de Inventario hayan sido auditados por sus responsables. La ejecución normal de despliegue se hace separadamente y requiere aprobación operativa y credenciales configuradas.

## Servicios aún deshabilitados

`api-gateway`, `bulk-svc`, `catalog-svc`, `combos-svc`, `price-audit-svc`, `pricing-svc`, `promotions-svc` y `taxonomy-svc` tienen valores cerrados de imagen, puerto, Compose, contenedor, proyecto y estado, pero `G6_SERVICE_ENABLED=false`. El workflow y el host los rechazan.

Habilitar uno requiere un cambio revisado al registro y preparación manual independiente de Oracle: directorio y Compose del servicio, archivo privado `/etc/g6-<servicio>/runtime.env` con permisos propios, permisos de solo lectura necesarios, healthcheck y red. El ejecutor se detiene si falta ese archivo. La plantilla genérica liga el puerto a `127.0.0.1`; no debe compartirse estado o archivo de secretos. No basta con cambiar `false` a `true` sin completar y comprobar ese entorno. Este lote no activa otros componentes.

## Secretos y operación del CD

El workflow conserva los nombres de secretos del PR #7. Deben provisionarse manualmente en GitHub Actions, nunca en archivos versionados:

| Secret                   | Propósito                                 |
| ------------------------ | ----------------------------------------- |
| `ORACLE_HOST`            | Host SSH verificado de la VM              |
| `ORACLE_USER`            | Usuario restringido de despliegue         |
| `ORACLE_SSH_PRIVATE_KEY` | Clave privada dedicada a Actions          |
| `ORACLE_SSH_KNOWN_HOSTS` | Clave del host verificada fuera de banda  |
| `ORACLE_GHCR_USERNAME`   | Usuario asociado al token de lectura GHCR |
| `ORACLE_GHCR_TOKEN`      | PAT dedicado con `read:packages`          |

El SSH debe aceptar únicamente el wrapper de despliegue mediante `authorized_keys`, sin PTY, forwarding ni shell interactiva. Conserva la ruta forzada existente:

```text
command="/usr/local/sbin/deploy-inventory-svc",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty <CLAVE_PUBLICA>
```

Verifica la huella de `known_hosts` fuera de banda; no uses `ssh-keyscan` como fuente de confianza. Limita la red SSH a runners con origen conocido y permite salida HTTPS hacia GHCR. El `GITHUB_TOKEN` publica con `packages: write`; el PAT enviado por stdin al host necesita solo `read:packages` y acceso al paquete. El puerto 3005 se mantiene en loopback; no requiere apertura del firewall ni de reglas de Oracle. No inspecciones ni modifiques el Compose o `.env` de RabbitMQ.

Para cada servicio futuro, crea su directorio `/etc/g6-<servicio>` como `root:g6-<servicio>` modo `0750` y el archivo `runtime.env` como `root:g6-<servicio>` modo `0640`, concediendo solo lectura al usuario de despliegue. Conserva credenciales y estado distintos por servicio. Inventario mantiene intactos `/etc/g6-inventory/runtime.env` y `/var/lib/g6-inventory`.

## Pruebas locales

La prueba `ops/oracle/tests/deploy-g6-service.test.sh` usa Docker/curl simulados y un registro temporal donde `catalog-svc` se habilita solo dentro de la simulación. Comprueba la compatibilidad del comando SSH previo, publicación y estado separados para dos servicios, rollback del segundo sin alterar Inventario, y rechazo de nombres, SHA, comandos y servicios deshabilitados. No despliega en Oracle.
