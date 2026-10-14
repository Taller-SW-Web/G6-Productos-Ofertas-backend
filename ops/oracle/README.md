# Despliegue de `inventory-svc` en Oracle Cloud

El Compose del servicio es independiente del Compose existente de RabbitMQ. Su único puerto publicado es `127.0.0.1:3005`; no abras `3005/tcp` en el firewall del host, la lista de seguridad ni el NSG de Oracle. El proxy HTTPS podrá conectarse a localhost cuando se configure por separado.

## Estado y alcance

El CD queda preparado, pero no operativo, hasta completar todos los pasos manuales de Oracle, GHCR y GitHub de esta guía. No se ha ejecutado un despliegue productivo. Inyectar `DATABASE_URL` tampoco significa que la aplicación ya se conecte a Supabase: el endpoint y el health check actuales verifican el proceso HTTP, no la conectividad, autenticación, permisos, esquema ni preparación de la base de datos. No hay evidencia aquí de una integración operativa con Supabase ni con G5.

## Preparación manual de Oracle

Los siguientes comandos suponen Ubuntu con Docker Engine, Compose v2 y ACL (`acl`/`setfacl`) instalados. Los bloques de las secciones 1, 2 y 4 se ejecutan en la VM Oracle mediante una cuenta administrativa con `sudo`; la sección 3 y la carga de GitHub Secrets se realizan en el equipo administrativo. La prueba de conectividad de Actions se ejecutará en un futuro job CD de GitHub Actions, después de configurar los Secrets. Verifica en Oracle `docker compose version`, `curl --version` y `setfacl --version` antes de continuar.

### 1. Crear el usuario y los directorios

El usuario SSH dedicado será `inventory-deploy`. Añádelo al grupo `docker` para ejecutar Compose; pertenecer a ese grupo equivale en la práctica a privilegios de root. No le concedas `sudo` general ni reutilices una cuenta personal.

```bash
sudo groupadd --system g6-inventory-deploy
sudo useradd --system --create-home --home-dir /home/inventory-deploy --shell /bin/bash --gid g6-inventory-deploy inventory-deploy
sudo passwd --lock inventory-deploy
sudo usermod --append --groups docker inventory-deploy
sudo install --directory --owner root --group g6-inventory-deploy --mode 0750 /opt/g6-productos-ofertas/inventory
sudo setfacl -m u:inventory-deploy:--x /opt/g6-productos-ofertas
sudo install --directory --owner root --group g6-inventory-deploy --mode 0750 /etc/g6-inventory
sudo install --directory --owner inventory-deploy --group g6-inventory-deploy --mode 0700 /var/lib/g6-inventory
```

Si el usuario o grupo ya existe, inspecciónalo y confirma propietario, grupo y permisos en lugar de recrearlo. La ACL concede a `inventory-deploy` solo búsqueda/travesía (`--x`) en el directorio padre existente: no cambia su propietario `ubuntu:ubuntu` ni sus bits `750`, y no concede lectura/listado del padre. No cambies ni leas el `.env` de RabbitMQ. Mantén `/var/lib/g6-inventory` privado para la cuenta de despliegue; allí se guardan `active-image` y `previous-image`.

### 2. Instalar Compose, script y archivo privado de entorno

Desde un checkout revisado de este PR, instala los dos artefactos en las ubicaciones que usa el script:

```bash
sudo install --owner root --group g6-inventory-deploy --mode 0640 docker-compose.inventory.yml /opt/g6-productos-ofertas/inventory/docker-compose.inventory.yml
sudo install --owner root --group root --mode 0755 ops/oracle/deploy-inventory-svc.sh /usr/local/sbin/deploy-inventory-svc
sudo install --owner root --group g6-inventory-deploy --mode 0640 /dev/null /etc/g6-inventory/runtime.env
sudoedit /etc/g6-inventory/runtime.env
```

En `runtime.env`, guarda solamente una asignación `DATABASE_URL` con el URI real entregado por el administrador de Supabase. Usa comillas simples alrededor del URI para que Compose lo trate literalmente. No escribas el valor en comandos, historial de shell, este repositorio, logs o tickets. El directorio queda `root:g6-inventory-deploy` con modo `0750` y el archivo `root:g6-inventory-deploy` con modo `0640`; así el usuario de despliegue puede leerlo para Compose, pero no modificarlo. No uses el `.env` ni ningún archivo del Compose de RabbitMQ.

Comprueba propietarios y modos sin imprimir el secreto:

```bash
sudo stat --format='%U:%G %a %n' /opt/g6-productos-ofertas/inventory /opt/g6-productos-ofertas/inventory/docker-compose.inventory.yml /etc/g6-inventory /etc/g6-inventory/runtime.env /var/lib/g6-inventory /usr/local/sbin/deploy-inventory-svc
sudo getfacl -p /opt/g6-productos-ofertas
namei -l /opt/g6-productos-ofertas/inventory/docker-compose.inventory.yml
namei -l /etc/g6-inventory/runtime.env
sudo -u inventory-deploy test -r /opt/g6-productos-ofertas/inventory/docker-compose.inventory.yml && echo 'Compose legible por inventory-deploy'
sudo -u inventory-deploy test -r /etc/g6-inventory/runtime.env && echo 'runtime.env legible por inventory-deploy'
sudo -u inventory-deploy env INVENTORY_IMAGE=ghcr.io/taller-sw-web/g6-productos-ofertas-backend/inventory-svc:SHA_DE_40_CARACTERES docker compose --file /opt/g6-productos-ofertas/inventory/docker-compose.inventory.yml --project-name g6-inventory config --quiet
```

Sustituye `SHA_DE_40_CARACTERES` por el SHA de la imagen que se quiere validar. El `test -r` confirma el acceso efectivo del usuario de despliegue. El comando Compose también se ejecuta como `inventory-deploy` y valida el archivo sin imprimir valores de entorno. El Compose inyecta `DATABASE_URL` desde `/etc/g6-inventory/runtime.env`; el script aborta antes de descargar o reemplazar el contenedor si el archivo no es legible o falta una asignación no vacía. El archivo permanece en Oracle y nunca viaja en la imagen ni en GitHub Actions.

### 3. Restringir SSH a la acción de despliegue

En el equipo administrativo protegido, genera una clave Ed25519 dedicada; guarda la privada directamente como GitHub Secret y copia solo la pública a Oracle. No reutilices claves personales.

```bash
ssh-keygen -t ed25519 -a 64 -N '' -f g6-inventory-oracle -C g6-inventory-deploy
sudo install --directory --owner inventory-deploy --group g6-inventory-deploy --mode 0700 /home/inventory-deploy/.ssh
sudoedit /home/inventory-deploy/.ssh/authorized_keys
sudo chown inventory-deploy:g6-inventory-deploy /home/inventory-deploy/.ssh/authorized_keys
sudo chmod 0600 /home/inventory-deploy/.ssh/authorized_keys
```

La línea de `authorized_keys` debe anteponer estas opciones a la clave pública generada:

```text
command="/usr/local/sbin/deploy-inventory-svc",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty <CLAVE_PUBLICA>
```

El comando forzado acepta únicamente `inventory-deploy <SHA de 40 caracteres hexadecimales>`. No permite shell, túneles, agente ni PTY. La clave sin frase de paso se limita con las opciones anteriores y se guarda solo como GitHub Secret. Verifica la huella de la clave pública SSH del host por un canal confiable y guarda la línea `known_hosts` verificada para GitHub. Para acceso de red, restringe el puerto 22 a un runner self-hosted con salida fija o a rangos de GitHub Actions vigentes y mantenidos; nunca uses `0.0.0.0/0`. Permite salida HTTPS desde Oracle para GHCR. El puerto 3005 no necesita regla de entrada.

Prueba la autenticación desde el equipo administrativo sin realizar despliegue: `ssh -vv -i g6-inventory-oracle -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes inventory-deploy@ORACLE_HOST connectivity-probe`. Configura antes `known_hosts` local con la huella verificada. La prueba debe mostrar autenticación con clave pública y el rechazo `comando remoto no autorizado`; ese rechazo es esperado porque la clave solo acepta el comando de despliegue. No uses `ssh-keyscan` como fuente de confianza.

### 4. Dar acceso de solo lectura a GHCR

El workflow publica con el `GITHUB_TOKEN` del repositorio y `packages: write`. Configura el paquete de GHCR para conceder a `Taller-SW-Web/G6-Productos-Ofertas-backend` acceso de escritura para Actions y confirma que la política de Actions del repositorio permite ese permiso. La cuenta de Oracle descarga la imagen usando un PAT clásico dedicado con únicamente `read:packages` y acceso de lectura al paquete privado. No almacenes ese PAT en Oracle: el workflow lo envía por stdin durante el despliegue y el script elimina su configuración temporal de Docker al terminar.

## Secrets manuales de GitHub

En `Taller-SW-Web/G6-Productos-Ofertas-backend`, abre **Settings → Secrets and variables → Actions → New repository secret** y configura:

| Secret                   | Valor que debe cargarse manualmente                                                 |
| ------------------------ | ----------------------------------------------------------------------------------- |
| `ORACLE_HOST`            | IP o hostname SSH de la VM                                                          |
| `ORACLE_USER`            | `inventory-deploy`, salvo que se haya elegido otro nombre y se actualice el secreto |
| `ORACLE_SSH_PRIVATE_KEY` | Contenido de la clave privada dedicada generada para esta VM                        |
| `ORACLE_SSH_KNOWN_HOSTS` | Entrada `known_hosts` del host, con huella verificada fuera de banda                |
| `ORACLE_GHCR_USERNAME`   | Usuario GitHub asociado al PAT de lectura del paquete                               |
| `ORACLE_GHCR_TOKEN`      | PAT clásico dedicado con alcance mínimo `read:packages`                             |

No añadas valores de secrets a archivos versionados. El job de despliegue falla explícitamente antes de abrir SSH si falta cualquiera de estos seis secretos.

## Comprobación de activación y operación

1. Instala inicialmente el Compose y el script en las rutas indicadas, configura `runtime.env`, GHCR, red, clave y los seis Secrets.
2. Fusiona el PR #7 cuando haya sido revisado y aprobado por sus responsables. Esta tarea no lo fusiona.
3. Comprueba en GitHub Actions que un evento `push` a `master` ejecuta `CI` con resultado exitoso y que después se inicia `CD inventory-svc Oracle`. Un `workflow_dispatch` solo se permite desde `master` y también exige un CI exitoso originado por `push` para el mismo SHA. Los CI de pull requests, incluidos los externos, no cumplen estas condiciones.
   Antes de enviar credenciales GHCR al host, el job CD ejecuta la misma prueba restringida desde el runner: debe autenticarse (no recibir error SSH 255) y recibir el rechazo de comando forzado esperado. Esto demuestra conectividad desde GitHub Actions y que la clave llega al wrapper configurado en Oracle. Si falla, revisa Secrets, `authorized_keys`, `known_hosts` y las reglas de red del puerto 22.
4. Considera el CD configurado únicamente cuando el workflow publique la etiqueta SHA en GHCR y el job de despliegue termine con éxito. Si falta preparación o un Secret, el job lo reporta como error; no lo interpretes como despliegue.
5. Tras una ejecución exitosa, verifica desde Oracle `docker compose --file /opt/g6-productos-ofertas/inventory/docker-compose.inventory.yml --project-name g6-inventory ps` y `curl --fail http://127.0.0.1:3005/health`. Esta última comprobación confirma salud del proceso HTTP solamente; la preparación real para consumir Supabase requiere una validación de conectividad y operaciones de base de datos definida y ejecutada por separado.

El host registra la imagen en `/var/lib/g6-inventory/active-image` y conserva la anterior en `/var/lib/g6-inventory/previous-image`. La validación exige que `g6-inventory-svc` use exactamente la imagen solicitada, que Docker reporte `healthy` y que `/health` responda HTTP exitosamente. Esto comprueba la salud del proceso HTTP; no demuestra que el servicio pueda conectarse, autenticarse o consultar Supabase. Las simulaciones automatizadas cubren arranque exitoso, fallo de descarga, fallo de arranque con restauración, fallo HTTP de salud con restauración, imagen desplegada incorrecta, estado Docker no saludable y primer despliegue no saludable sin versión previa.

## Actualizaciones de artefactos

El workflow publica la imagen desde el commit, pero no sincroniza el Compose ni el script hacia Oracle. Cada cambio posterior a `docker-compose.inventory.yml` o `ops/oracle/deploy-inventory-svc.sh` requiere reinstalarlos manualmente en `/opt/g6-productos-ofertas/inventory/docker-compose.inventory.yml` y `/usr/local/sbin/deploy-inventory-svc`, respectivamente, con los propietarios y permisos de esta guía. No se debe asumir que el CD actualizó esos archivos.
