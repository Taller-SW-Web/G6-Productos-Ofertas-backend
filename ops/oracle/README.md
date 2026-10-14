# CD de servicios G6 en Oracle Cloud

El CD publica imágenes inmutables por SHA en GHCR y despliega mediante SSH restringido. El manifiesto declarativo `ops/oracle/services.psv`, leído sin ejecutarlo por `ops/oracle/service-registry.sh`, contiene exactamente los nueve componentes del monorepo, sus puertos, variables específicas de puerto, rutas, imágenes, contenedores, estados y archivos privados de runtime; **`inventory-svc` es el único habilitado**. Los ocho servicios restantes se rechazan tanto en la ejecución manual como en el host Oracle hasta que se preparen y autoricen expresamente.

## Estado y límites

- El PR #7 dejó instalado el comando SSH `/usr/local/sbin/deploy-inventory-svc` y el Compose `/opt/g6-productos-ofertas/inventory/docker-compose.inventory.yml`. La ruta de comando antigua `inventory-deploy <SHA de 40 caracteres>` continúa siendo aceptada.
- El ejecutor común solo recibe un identificador del registro y un SHA hexadecimal de 40 caracteres. Rutas, imagen, proyecto Compose, contenedor, puerto y directorio de estado salen de valores constantes del registro. No acepta shell, rutas, nombre de contenedor ni destino como argumentos.
- `deploy-g6-service --version` informa `ejecutor=3 registro=2`; el ejecutor rechaza un registro cuya versión no está soportada. La versión de ejecutor 3 incorpora exclusión mutua por servicio con `flock`. La salida verifica versiones declaradas; los checksums de registro, manifiesto, ejecutor y Compose deben compararse con el commit revisado del PR.
- Cada servicio tiene un proyecto Compose, contenedor y directorio de estado propios. Las operaciones apuntan a un único servicio; no usan `down`, `--remove-orphans` ni cambian la configuración de RabbitMQ.
- El healthcheck confirma el proceso HTTP en `/health`. No acredita conectividad, credenciales o preparación de Supabase.
- No se ha desplegado en la VM ni configurado ningún secreto real como parte de este cambio.

## Controles de GitHub Actions

El workflow `CD servicios Oracle` solo procesa un `push` de `master` con CI exitoso del mismo repositorio. Descarta SHAs que ya no son la punta de `master`, vuelve a comprobar la vigencia antes de SSH y publica cada imagen con su SHA. El selector compara cambios desde el último GitHub Deployment exitoso de cada servicio. Cambios únicamente bajo `apps/<servicio>/` afectan a ese servicio; dependencias, Dockerfiles, configuración de compilación, cambios transversales y rutas no clasificadas afectan a todos los habilitados. Los cambios documentales bajo `docs/**` o archivos Markdown no reconstruyen imágenes. `workflow_dispatch` conserva la selección por servicio y el registro rechaza los ocho deshabilitados.

Cada fila de la matriz es independiente y publica y despliega solo su servicio; un fallo de publicación no cancela las otras filas. Las filas usan `fail-fast: false` y un grupo de concurrencia común por repositorio y servicio, tanto para CD automático como manual. El ejecutor vuelve a serializar en Oracle mediante `flock` con un archivo dentro del directorio de estado propio del servicio; conserva el bloqueo durante despliegue y rollback, y falla cerrado si `flock` no está disponible. Así una operación no puede pisar sus archivos `active-image`/`previous-image` ni otro servicio. El job preparatorio tiene `actions: read`, `contents: read` y `deployments: read`; cada job de publicación tiene solo `contents: read`, `packages: write` y `deployments: write`. CI valida sintaxis y expresiones de todos los workflows con actionlint. Antes de enviar el token de GHCR, Actions valida presencia de secretos, host SSH mediante `known_hosts` y autenticación con la clave restringida. El host valida el servicio, el SHA, la imagen actual, el healthcheck de Docker y HTTP; si la versión nueva falla, restaura solo el servicio elegido.

## Historial de despliegue y recuperación

GitHub Deployments usa un entorno cerrado por servicio, `g6-oracle-<servicio>`, y la tarea `deploy`. El job crea un deployment en estado `in_progress` antes de SSH. Solo publica `success` cuando el comando remoto termina correctamente; el ejecutor solo devuelve éxito tras validar el healthcheck HTTP y de Docker. Un error de publicación no crea deployment. Un fallo de despliegue registra `failure` y un trabajo cancelado que no alcanza el paso final queda en estado no exitoso. Ninguno avanza el SHA exitoso.

El selector ordena Deployments por `created_at` descendente y, para empates del mismo segundo, por ID numérico descendente; aplica el mismo desempate a los estados de cada Deployment. Nunca ordena alfabéticamente por nombre del estado ni usa el orden de respuesta de la API. IDs duplicados/malformados, fechas inválidas, historial vacío o errores de API invalidan la certeza y seleccionan conservadoramente el servicio. `github-deployment-api.sh` centraliza las solicitudes de escritura y sus argumentos se validan contra el registro cerrado. `tests/deployment-api.test.sh` ejercita escritura y lectura contra una API simulada que comprueba endpoints, parámetros y payloads.

El selector pagina la lista de deployments y estados por servicio. Usa el SHA del estado exitoso más reciente cuya relación con el SHA actual de `master` puede verificarse, siempre que no haya un intento más reciente cuyo estado no sea `success`. Ante `failure`, `error`, cancelación (`in_progress`), estado desconocido, historial/status incompleto, API fallida, SHA que no sea ancestro de `master` o error de `git diff`, selecciona ese servicio: un fallo puede haber terminado en rollback verificado o haber dejado el host incierto. Una falla de API para todos los servicios termina incluyendo todos los habilitados. Los registros de éxito los escribe únicamente el workflow después de completar SSH; no se deben crear manualmente.

### Reconciliar GitHub con el estado real de Oracle

1. Pausa cambios operativos del servicio y compara de forma solo lectura la imagen del contenedor y su archivo `active-image` con los deployments de `g6-oracle-<servicio>`. Para Inventario, las rutas y contenedor existentes siguen siendo `/var/lib/g6-inventory/active-image` y `g6-inventory-svc`. No edites `active-image`/`previous-image` ni alteres estados de GitHub para hacerlos coincidir.
2. Si Oracle tiene una imagen nueva sin deployment `success`, o GitHub dice `success` pero Oracle tiene otra imagen, el historial no representa de forma confiable el estado real. Verifica que la imagen actual pertenezca al repositorio y al nombre/SHA cerrados del servicio; si no coincide, el ejecutor la rechazará y se debe resolver la discrepancia antes de continuar. Con aprobación operativa para desplegar, ejecuta `workflow_dispatch` en `master` seleccionando ese servicio; exige CI exitoso para el SHA actual y deja que el workflow vuelva a desplegar, comprobar salud y registrar un nuevo éxito.
3. Si no hay autorización o credenciales para esa reconciliación, conserva el estado actual y no marques manualmente un deployment como exitoso. Un historial ausente, pendiente o ilegible mantiene el servicio seleccionado en la siguiente ejecución automática. Registra la discrepancia para revisión operativa.

La plantilla genérica fija `PORT` y la variable específica (`*_PORT`) al mismo puerto del registro; ambas variables explícitas de Compose prevalecen sobre `runtime.env`. El healthcheck de Compose y la publicación loopback usan el mismo puerto. Inventario mantiene `INVENTORY_SVC_PORT=3005` y añade `PORT=3005` a su Compose versionado; la ruta, el contenedor y el healthcheck existente siguen en 3005.

## Transición segura del wrapper de Inventario

El despliegue anterior debe permanecer disponible hasta completar todas las comprobaciones. Los comandos `sudo install` siguientes requieren aprobación operativa explícita para cambiar archivos privilegiados en Oracle; este PR y el CD no sincronizan ni instalan esos archivos. Ejecuta el procedimiento manual como administrador solo después de esa autorización. **No ejecutes `docker compose up`, `pull`, reinicios ni el comando de despliegue durante la instalación o verificación.**

### 1. Guardar una copia recuperable del mecanismo instalado

Comprueba primero la ruta y checksum actuales; la ruta del Compose debe seguir siendo la del PR #7:

```bash
sudo stat --format='%U:%G %a %n' /usr/local/sbin/deploy-inventory-svc /opt/g6-productos-ofertas/inventory/docker-compose.inventory.yml
sudo sha256sum /usr/local/sbin/deploy-inventory-svc
sudo install --directory --owner root --group root --mode 0700 /var/backups/g6-productos-ofertas
sudo cp --preserve=mode,ownership,timestamps /usr/local/sbin/deploy-inventory-svc /var/backups/g6-productos-ofertas/deploy-inventory-svc.pr7
sudo sha256sum /usr/local/sbin/deploy-inventory-svc /var/backups/g6-productos-ofertas/deploy-inventory-svc.pr7
```

Confirma que ambos checksums coincidan antes de seguir. No muevas ni reemplaces el Compose o los archivos de `/etc/g6-inventory` y `/var/lib/g6-inventory` sin aprobación operativa. El Compose versionado ahora iguala `PORT` con `INVENTORY_SVC_PORT=3005`; para instalarlo en `/opt/g6-productos-ofertas/inventory/docker-compose.inventory.yml`, respáldalo, compara el checksum, valida el archivo candidato con `docker compose config --quiet` y sustitúyelo atómicamente. Esa actualización no ejecuta `up`, `pull` ni reinicios y debe estar aprobada antes del próximo despliegue genérico de Inventario.

Antes de instalar, anota el SHA del checkout revisado del PR y sus checksums de `service-registry.sh`, `services.psv`, `deploy-g6-service.sh` y `docker-compose.service.yml`. Conserva esa evidencia junto con la aprobación operativa.

### 2. Instalar el registro y el ejecutor genérico en rutas nuevas

Desde el checkout revisado del PR:

```bash
sudo install --directory --owner root --group root --mode 0755 /usr/local/lib/g6-productos-ofertas
sudo install --owner root --group root --mode 0644 ops/oracle/service-registry.sh /usr/local/lib/g6-productos-ofertas/service-registry.sh
sudo install --owner root --group root --mode 0644 ops/oracle/services.psv /usr/local/lib/g6-productos-ofertas/services.psv
sudo install --owner root --group root --mode 0755 ops/oracle/deploy-g6-service.sh /usr/local/lib/g6-productos-ofertas/deploy-g6-service
sudo install --directory --owner root --group root --mode 0755 /opt/g6-productos-ofertas/shared
sudo install --owner root --group root --mode 0644 ops/oracle/docker-compose.service.yml /opt/g6-productos-ofertas/shared/docker-compose.service.yml
sudo sha256sum /usr/local/lib/g6-productos-ofertas/service-registry.sh /usr/local/lib/g6-productos-ofertas/services.psv /usr/local/lib/g6-productos-ofertas/deploy-g6-service /opt/g6-productos-ofertas/shared/docker-compose.service.yml
sudo -u inventory-deploy env -u SSH_ORIGINAL_COMMAND /usr/local/lib/g6-productos-ofertas/deploy-g6-service --version
```

Compara checksums contra el checkout revisado y exige la salida exacta `ejecutor=3 registro=2`. No continúes ante diferencias o versiones incompatibles. La versión 3 requiere `flock` y guarda `deploy.lock` dentro del estado privado de cada servicio; el bloqueo se mantiene durante pull, cambio de contenedor, comprobación de salud y rollback. No cambies la ruta de estado de Inventario.

Antes de cambiar el wrapper, inspecciona que solo Inventario está habilitado y valida el Compose actual sin imprimir secretos ni cambiar contenedores:

```bash
sudo bash -c 'source /usr/local/lib/g6-productos-ofertas/service-registry.sh; g6_enabled_services_json'
sudo -u inventory-deploy test -r /usr/local/lib/g6-productos-ofertas/service-registry.sh
sudo -u inventory-deploy test -x /usr/local/lib/g6-productos-ofertas/deploy-g6-service
sudo -u inventory-deploy test -r /opt/g6-productos-ofertas/inventory/docker-compose.inventory.yml
sudo -u inventory-deploy test -r /etc/g6-inventory/runtime.env
sudo -u inventory-deploy env INVENTORY_IMAGE=ghcr.io/taller-sw-web/g6-productos-ofertas-backend/inventory-svc:SHA_DE_40_CARACTERES docker compose --file /opt/g6-productos-ofertas/inventory/docker-compose.inventory.yml --project-name g6-inventory config --quiet
```

La salida del registro debe ser exactamente `["inventory-svc"]`. Sustituye el marcador por un SHA real de imagen únicamente para validar la sintaxis de Compose; no uses `up` ni `pull`. El archivo Compose versionado fija `PORT` y `INVENTORY_SVC_PORT` a `3005`, con puerto loopback y healthcheck `/health` en 3005, igual que el registro y `inventory-svc`.

Con aprobación operativa independiente, actualiza el Compose instalado antes de desplegar una imagen genérica de Inventario; conserva el archivo anterior para restaurarlo. La candidata se valida sin resolver ni imprimir el contenido privado y sin iniciar contenedores:

```bash
sudo cp --preserve=mode,ownership,timestamps /opt/g6-productos-ofertas/inventory/docker-compose.inventory.yml /var/backups/g6-productos-ofertas/docker-compose.inventory.yml.pr7
sudo install --owner root --group root --mode 0644 docker-compose.inventory.yml /opt/g6-productos-ofertas/inventory/docker-compose.inventory.yml.new
sudo env INVENTORY_IMAGE=ghcr.io/taller-sw-web/g6-productos-ofertas-backend/inventory-svc:SHA_DE_40_CARACTERES docker compose --file /opt/g6-productos-ofertas/inventory/docker-compose.inventory.yml.new config --quiet
sudo mv --no-target-directory /opt/g6-productos-ofertas/inventory/docker-compose.inventory.yml.new /opt/g6-productos-ofertas/inventory/docker-compose.inventory.yml
```

Si la validación falla, elimina solo el candidato `.new`; si el cambio ya se sustituyó y la operación lo requiere, instala el respaldo como `.restore` y usa `mv --no-target-directory` para volver a la versión anterior. Verifica checksum y permisos. No ejecutes el despliegue como parte de esta actualización.

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

Habilitar uno requiere un cambio revisado al registro y preparación manual independiente de Oracle: directorio y Compose del servicio, archivo privado `/etc/g6-<servicio>/runtime.env` con permisos propios, permisos de solo lectura necesarios, healthcheck y red. El ejecutor se detiene si falta ese archivo. La plantilla genérica liga `PORT` y su variable específica a un mismo puerto `127.0.0.1`; no debe compartirse estado o archivo de secretos. No basta con cambiar `false` a `true` sin completar y comprobar ese entorno.

Transición reversible, solo tras aprobación operativa para esa activación:

1. Prepara manualmente el Compose, ruta, entorno privado, permisos y healthcheck del servicio; valida el Compose con `config --quiet` y sin `up`/`pull`.
2. Revisa un PR que solo cambie el `enabled` del servicio requerido a `true`; conserva los demás en `false`. Comprueba CI, que la versión del ejecutor siga compatible con el registro y que el filtro y dispatch manual aún validen el nombre cerrado.
3. En Oracle, crea un directorio candidato root-only dentro de `/usr/local/lib/g6-productos-ofertas`, copia allí el `service-registry.sh` y `services.psv` revisados, y ejecuta `source <candidato>/service-registry.sh; g6_enabled_services_json`. Verifica la versión del ejecutor instalado con `env -u SSH_ORIGINAL_COMMAND /usr/local/lib/g6-productos-ofertas/deploy-g6-service --version`; compara checksum del candidato con el checkout aprobado.
4. Respalda el `services.psv` instalado en `/var/backups/g6-productos-ofertas`, instala el candidato como `/usr/local/lib/g6-productos-ofertas/services.psv.new` y usa `mv --no-target-directory` dentro del mismo directorio para sustituirlo atómicamente. Verifica `g6_enabled_services_json` como administrador y exige exactamente `inventory-svc` más el servicio autorizado.
5. Si la verificación falla, instala el respaldo como `services.psv.restore` y restáuralo con `mv --no-target-directory`; compara el checksum restaurado. El wrapper y su comando SSH no cambian; no se despliega ni reinicia el servicio durante esta transición.
6. La primera publicación/despliegue requiere una operación aprobada y separada. La instalación de archivos privilegiados no se automatiza en GitHub Actions.

Secuencia atómica de activación tras revisar el PR y obtener aprobación operativa (sustituye `<ticket>` por un identificador real; no ejecutes este ejemplo en este lote):

```bash
sudo install --directory --owner root --group root --mode 0700 /usr/local/lib/g6-productos-ofertas/candidato
sudo install --owner root --group root --mode 0644 ops/oracle/service-registry.sh /usr/local/lib/g6-productos-ofertas/candidato/service-registry.sh
sudo install --owner root --group root --mode 0644 ops/oracle/services.psv /usr/local/lib/g6-productos-ofertas/candidato/services.psv
sudo bash -c 'source /usr/local/lib/g6-productos-ofertas/candidato/service-registry.sh; g6_enabled_services_json'
sudo cp --preserve=mode,ownership,timestamps /usr/local/lib/g6-productos-ofertas/services.psv /var/backups/g6-productos-ofertas/services.psv.before-<ticket>
sudo install --owner root --group root --mode 0644 /usr/local/lib/g6-productos-ofertas/candidato/services.psv /usr/local/lib/g6-productos-ofertas/services.psv.new
sudo mv --no-target-directory /usr/local/lib/g6-productos-ofertas/services.psv.new /usr/local/lib/g6-productos-ofertas/services.psv
sudo bash -c 'source /usr/local/lib/g6-productos-ofertas/service-registry.sh; g6_enabled_services_json'
```

Comprueba el checksum del candidato contra el commit aprobado antes del `mv`; después, la lista debe contener Inventario y únicamente el servicio autorizado. Si falla la validación posterior, restaura atómicamente el respaldo mediante `install` a `services.psv.restore` y `mv --no-target-directory`. Conserva el wrapper actual y no ejecutes un despliegue como prueba.

Este lote mantiene los ocho componentes deshabilitados.

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

Las pruebas `ops/oracle/tests/deploy-g6-service.test.sh`, `select-cd-services.test.sh` y `publish-isolation.test.sh` usan registros temporales o simulación local. Comprueban compatibilidad del comando SSH previo, versión y rechazo de incompatibilidad, rollback, despliegues simultáneos, rollback concurrente, wrapper manual frente al comando automático, aislamiento de dos servicios, cambios exclusivos y compartidos, CI fallido/cancelado sin avance, CD fallido, historial ausente/incompleto/error de API, nuevo servicio habilitado sin baseline y recuperación de cambios pendientes. Verifican que `success` se registra después de publicación y SSH/health. El CI además construye y ejecuta `Dockerfile.service` para Inventario y Catálogo, valida ambos Compose y sus puertos/env/healthchecks. Nada de esto despliega en Oracle.
