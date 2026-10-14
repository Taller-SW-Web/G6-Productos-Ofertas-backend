# Despliegue de `inventory-svc` en Oracle Cloud

Este despliegue es independiente del Compose de RabbitMQ. El puerto del servicio queda enlazado a `127.0.0.1:3005`; el proxy HTTPS podrá consumirlo localmente cuando se configure. No abras el puerto 3005 en el firewall del sistema operativo ni en la lista de seguridad/NSG de Oracle.

## Estado requerido antes de activar el CD

El CD queda **preparado, no activado** hasta completar la configuración de Oracle y de GitHub. La creación de estos archivos no acredita que la VM exista, que tenga Docker, que la clave esté instalada ni que haya ocurrido un despliegue.

### Preparar Oracle (administrador de la VM)

1. Instala Docker Engine con el plugin Compose v2 y `curl`; verifica `docker compose version`.
2. Crea `/opt/g6/inventory` y copia allí `docker-compose.inventory.yml` de este repositorio. Mantén el Compose de RabbitMQ intacto. El usuario de despliegue debe poder usar Docker y escribir el estado en `/var/lib/g6-inventory`.
3. Crea `/var/lib/g6-inventory` con modo `0700`.
4. Instala `deploy-inventory-svc.sh` como `/usr/local/sbin/deploy-inventory-svc`, propietario `root:root`, modo `0755`. Revisa su contenido antes de instalar.
5. Crea una cuenta SSH dedicada sin contraseña interactiva/sudo general. Instala una clave dedicada en `authorized_keys` con estas opciones antes de la clave pública (ajusta la ruta del script solo si también actualizas el `ForceCommand`):

   ```text
   command="/usr/local/sbin/deploy-inventory-svc",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty <CLAVE_PUBLICA>
   ```

   Restringe además SSH entrante a las IPs de GitHub Actions si se usa un runner con IP controlable; con runners hospedados las IP cambian, por lo que se recomienda un runner self-hosted con salida fija o un mecanismo de acceso privado. Nunca abras el puerto 3005 al exterior.

6. Confirma que la cuenta tiene permiso mínimo suficiente sobre Docker y `/var/lib/g6-inventory`; pertenecer al grupo `docker` equivale en la práctica a privilegios de root.
7. Copia y conserva el SHA-256 de la clave pública del host en un canal confiable para alimentar `ORACLE_SSH_KNOWN_HOSTS`. No uses `ssh-keyscan` sin verificar la huella.
8. Comprueba en la VM que `curl http://127.0.0.1:3005/health` es accesible después del primer despliegue.

La llave de despliegue debe ser dedicada y restringida al comando forzado. No reutilices la llave de una persona.

### Configurar GitHub Secrets

Añade los siguientes **repository secrets** al repositorio `Taller-SW-Web/G6-Productos-Ofertas-backend`; los valores reales nunca deben escribirse en Git:

| Secret                   | Contenido                                                                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ORACLE_HOST`            | IP o hostname SSH de la VM Oracle                                                                                                                     |
| `ORACLE_USER`            | Usuario SSH dedicado a este despliegue                                                                                                                |
| `ORACLE_SSH_PRIVATE_KEY` | Clave privada dedicada cuya pública está en `authorized_keys` con comando forzado                                                                     |
| `ORACLE_SSH_KNOWN_HOSTS` | Línea(s) `known_hosts` previamente verificadas para ese host                                                                                          |
| `ORACLE_GHCR_USERNAME`   | Usuario de GitHub asociado al token lector de paquetes                                                                                                |
| `ORACLE_GHCR_TOKEN`      | PAT clásico dedicado con solo `read:packages` y acceso al paquete privado; no uses `GITHUB_TOKEN` porque Oracle no puede obtenerlo fuera del workflow |

Configura además el paquete GHCR para que `GITHUB_TOKEN` del repositorio pueda publicar (`packages: write`) y confirma que la VM pueda descargar el paquete. El workflow no ejecuta SSH si falta un secreto: fallará con un mensaje explícito.

## Activación y operación

1. Revisa el PR hacia `master`. No se ha ejecutado ningún despliegue desde esta tarea.
2. Tras fusionar el PR y completar los pasos anteriores, el CD publica `ghcr.io/taller-sw-web/g6-productos-ofertas-backend/inventory-svc:<SHA>` solo cuando el workflow `CI` finaliza exitosamente para `master`. `workflow_dispatch` acepta únicamente la referencia `master`.
3. En `master`, verifica `/health` localmente en Oracle y deja la configuración del proxy HTTPS para su cambio coordinado independiente.
4. El host guarda la imagen activa en `/var/lib/g6-inventory/active-image` y la imagen previa en `/var/lib/g6-inventory/previous-image`. Si `/health` falla después de hasta 60 segundos, el script vuelve a iniciar y verificar la imagen anterior. El primer despliegue sin versión previa se detiene y elimina el contenedor no saludable.

El workflow serializa despliegues y descarta el SHA si `master` avanzó antes del despliegue. Las ejecuciones manuales también requieren `master` como referencia y que su SHA siga siendo la punta actual.
