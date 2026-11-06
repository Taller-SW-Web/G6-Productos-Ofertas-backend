# Preparación optativa de conectividad RabbitMQ — Oracle H4

**Estado:** implementación candidata para pruebas aisladas. No habilitada en Oracle. No cambia RabbitMQ, redes, secretos, CD, Gateway ni contratos.

**Base de código:** Backend `master` SHA `61171913510daddc5baedc9532b236de1953fac5`. **Contrato consultado:** Docs SHA `a7778ec1a22811c1213a94ef096ab905911342cc`, AsyncAPI `0.6.0-rc.4`. La descripción rc.4 califica la topología base como observación histórica (19-oct), no acredita conectividad, grants ni E2E y mantiene Retry/DLX sin aprobación ni aprovisionamiento. La red `g6-po_g6_backend` se reutiliza únicamente como hipótesis candidata, sujeta a inspección actual y aprobación operativa.

## Modelo de activación

El candidato `deploy-g6-service-v6.sh` conserva el protocolo remoto `service-deploy <servicio> <SHA-40>` e `inventory-deploy <SHA-40>`, el registro v2, selección cerrada, locks, health/readiness, rollback individual, puertos loopback y overlays HTTP. El ejecutor v5 del repositorio no se reemplaza; v6 tiene archivo separado y solo se instalaría mediante una operación futura aprobada.

El único selector de pertenencia de red es `/etc/g6-productos-ofertas/amqp-opt-in.psv`, con formato:

```text
#g6-amqp-opt-in-version=1
inventory-svc
```

La lista vacía o el archivo ausente significa ningún servicio opt-in. Solo acepta nombres exactos de los ocho servicios, sin duplicados. Rechaza Gateway, Caddy, filas extrañas, symlinks (incluidos los colgantes), archivos no root-owned o modificables por grupo/otros. Contiene nombres, nunca secretos. Se lee como datos; no se ejecuta. La selección se hace por servicio en cada despliegue: una fila para Inventory no adjunta Combos ni Bulk. Gateway omite la lectura del manifiesto, que no lo puede habilitar ni bloquear por estar corrupto.

La selección exige un runtime env legible, una URL AMQP con usuario, contraseña, host `rabbitmq` y vhost contractual `g6-productos-ofertas`; se admite codificación porcentual del path compatible con los parsers que decodifican `URL.pathname`. Pricing y Price Audit exigen `amqps`. Se valida sin imprimir ni retornar el valor. Flags de consumidor/publicador siguen siendo configuración de cada servicio y no los altera el selector. En concreto, la pertenencia de red, configuración válida y runtime funcional son estados separados. El código actual no expone un flag AMQP uniforme; las excepciones se detallan abajo.

En un despliegue normal el ejecutor agrega `docker-compose.service.amqp.yml` o `docker-compose.inventory.amqp.yml` solo cuando el servicio figura en la lista. Si no figura, se aplica base + overlay HTTP. Si figura, exige el overlay, valida el runtime y comprueba la red antes de `docker login`, `pull` o `up`. No crea redes. Si el contenedor actual sí tenía membresía AMQP y la selección nueva la quita, inspecciona y valida esa red antes de modificarlo para que un rollback pueda restaurar el perfil anterior; si esa inspección falla, se detiene antes del pull/up.

## Red, aislamiento y límites

La alternativa candidata reutiliza `g6-po_g6_backend`, cuyo nombre/miembros solo están respaldados por la auditoría histórica del 19-oct: bridge local, RabbitMQ como único miembro observado, alias `rabbitmq`; contenedor histórico `g6-po-rabbitmq-1`. El preflight v6 verifica nombre exacto, `bridge`, `local`, `internal=false`, `attachable=false`, `ingress=false`, `config-only=false`, IPAM `default`, sin opciones y miembro RabbitMQ esperado. Los únicos otros miembros admitidos son contenedores de servicios registrados en la lista opt-in más el servicio que se está retirando. Verifica labels Compose y aliases canónicos; solo tolera el alias Compose genérico `service` repetido entre proyectos. Cualquier contenedor externo, atributo distinto o alias conflictivo detiene antes de modificar el servicio.

El overlay AMQP nunca declara `g6-http` ni `g6-edge`; el Compose base mantiene publicación HTTP en `127.0.0.1`. Gateway y Caddy no se admiten. Los puertos 5672/5671/15672 no se publican ni se cambian. La validación Docker no demuestra ACL RabbitMQ, identidad, TLS funcional, routing, bindings, readiness ni que un mensaje llegue. La red bridge permite comunicación lateral entre sus miembros; el archivo de selección no es un firewall por contenedor. El broker necesita grants mínimos por identidad y una auditoría actual de miembros/aliases. Si el requisito operativo demanda aislamiento entre cada servicio, se debe preparar una red dedicada por servicio o punto de acceso privado separado y conectar el broker bajo una autorización de infraestructura diferente; no se incluye aquí.

## Configuración y capacidad por componente

La posibilidad HTTP sin AMQP se refiere a composición/despliegue, no a aceptación funcional ni `READY_FOR_DEPLOY`. En todos los casos siguen aplicando `CHECKLIST_PREDEPLOY.md`, readiness honesta, SHA e imagen verificados y autorización individual.

| Componente | HTTP sin AMQP | Configuración AMQP observada en el código de referencia | Efecto/readiness si se configura | Dependencia y bloqueo actual | Evidencia previa a opt-in |
|---|---|---|---|---|---|
| `api-gateway` | Sí; despliegue HTTP/edge independiente | No hay parser/consumidor AMQP. | No candidato; readiness conserva sus upstreams HTTP. | Excluido siempre del manifiesto y overlay. Estado Docker unhealthy proporcionado por Marco pertenece a otro trabajo. | Confirmar que no aparece en red RabbitMQ ni Compose AMQP; validar readiness/health HTTP por su propio gate. |
| `bulk-svc` | Sí, aunque HTTP/health no demuestra carga masiva lista. | `BULK_AMQP_ENABLED`, `BULK_AMQP_URL`. | Transporte opcional y apagado por defecto; readiness de producción puede exigir AMQP y workers activos. La URL no activa por sí sola el flag. | Compatibilidad de nombres, cuenta/ACL y flujo con Catalog no acreditados. No declarar Bulk listo solo por HTTP. | URL válida; flag booleano; AMQPS donde se requiera por política aprobada; prueba aislada de worker/readiness; nombres, ACL y productor/consumidor homologados. |
| `catalog-svc` | Sí para HTTP/DB independiente. | `CATALOG_AMQP_ENABLED`, `RABBITMQ_URL`, `CATALOG_AMQP_PRODUCER_USERS`. | Flag controla runtime. `AMQP_RECOVERY_BLOCKED` permanece; no usar recuperación aislada como producción. Si flag true, el JSON de productores es requerido por parser. | Retry/DLX bloqueado y topología/código deben reconciliarse; no afirmar Bulk↔Catalog operativo. | URL y productores válidos; flag separado; prueba que confirma el bloqueo de recuperación; paridad de exchange/queue/routing y ACL aprobada. |
| `combos-svc` | Sí; transporte opcional. | `COMBOS_AMQP_ENABLED`, `COMBOS_AMQP_URL`. | Default apagado. Con flag true, parser requiere URL y readiness refleja conexión/canal/suscripción reales. | Falla real al habilitar debe aparecer en readiness; ACL/topología no acreditadas. | URL válida y flag bool; prueba isolated de fallo/recuperación readiness; topología y permisos reconciliados. |
| `inventory-svc` | Sí para HTTP/BD; Outbox puede quedar durable y `PENDING`. | `RABBITMQ_URL` opcional para bootstrap y necesaria para publicar. | No flag AMQP uniforme; al proveer URL se habilita el transporte existente. No se altera su proyecto `g6-inventory`, Compose histórico raíz `docker-compose.inventory.yml`, wrapper, `/etc/g6-inventory/runtime.env`, estado ni puerto 3005. | Outbox pendiente conserva operación HTTP/DB; nombres actuales candidato difieren de la observación física. | URL válida en ruta histórica; confirmar readiness DB/HTTP independiente; prueba Outbox local; reconciliar queue/exchange/routing y ACL antes del runtime compartido. |
| `taxonomy-svc` | Sí para HTTP/DB independiente. | `RABBITMQ_URL`, `TAXONOMY_CATALOG_AMQP_USER`. | No existe flag `TAXONOMY_AMQP_ENABLED`; ambos valores configuran e inician el runtime. La pertenencia de red más estos valores puede iniciar conexión/consumo; la selección de red sola no escribe estos valores. Readiness debe reflejar falla real habilitado. | Código AMQP presente, pero operación/bindings/ACL actuales no acreditados. | Confirmar ventana controlada para activar por configuración; identidad distinta y permisos mínimos; readiness/failure aislado; homologación de nombres. |
| `promotions-svc` | Despliegue HTTP técnicamente independiente; configuración actual exige URL. | `RABBITMQ_URL` obligatoria; `PROMOTIONS_COUPON_RUNTIME_ENABLED` y `PROMOTIONS_DEPENDENCY_PROBES_ENABLED` separados y apagados por defecto. | URL presente no significa conexión. Los flags pueden iniciar probes/consumidores y deben conservarse como están salvo gate independiente. | Código candidato tiene discrepancia de nombres con lo observado; probes no crean topología. | URL válida y flags explícitos; no activar runtime en este alcance; prueba de readiness y ACL/topología aprobadas. |
| `pricing-svc` | Sí; AMQP no es requisito general de HTTP. | `PRICING_AMQP_URL`, `PRICING_PRICE_CHANGED_PUBLISH_ENABLED`. | Producción exige AMQPS (no se debilita TLS); URL y flag son estados separados, readiness refleja publicación si habilitada. | No se verificó listener AMQPS en el broker. Bloqueo específico de AMQP hasta prueba TLS. | AMQPS válido con CA/hostname verificados; confirmar listener y certificado actuales, identidad/ACL y prueba publish aislada aprobada. |
| `price-audit-svc` | Sí, mientras sus operaciones HTTP/DB tengan su propio código y readiness. | `PRICE_AUDIT_AMQP_URL`; parser actual exige AMQPS en producción. El scaffold no demuestra por sí mismo un consumidor funcional. | Configurar URL no demuestra que exista una capacidad AMQP implementada/consumida ni readiness de negocio. | Listener AMQPS no verificado; contrato/evento y capacidad implementada requieren confirmación del owner. | Listener/certificado AMQPS; evento/operación AsyncAPI aplicable; implementación y readiness exactas, ACL y prueba local. |

La revisión de parsers es contra Backend `master` SHA `6117191…`; las fichas históricas de `ops/oracle/servicios/` contienen datos de cortes previos y no reemplazan este mapeo. No se cambió código de negocio.

## Compatibilidad con v5 y registro v2

| Ejecutable v5 / estado provisto de Oracle | Candidato de este cambio |
|---|---|
| v5 instalado según el corte declarado por Marco; no se consultó VM. | `deploy-g6-service-v6.sh`, explícitamente v6; nunca se presenta como instalado. |
| `service-registry.sh` y `services.psv` registro v2. | Registro v2 se conserva; composición y release HTTP no requieren migración de registro. |
| Compose base, overlay HTTP genérico, Gateway e Inventory permanecen sin cambios. | Dos overlays AMQP nuevos; no se modifica base, Gateway, Caddy o workflow. |
| Sin selector AMQP: comportamiento HTTP actual. | Sin fila no añade overlay AMQP; si el contenedor anterior tenía esa red, v6 la valida solo para preservar rollback y luego aplica el perfil HTTP. |
| Inventory usa wrapper/Compose/proyecto legacy y ruta propia. | Mismo comando y rutas; v6 compone su overlay AMQP dedicado solo al opt-in. |

El candidato conserva control de concurrencia, SHA inmutable, healthchecks, readiness adicional de Catalog, loopback y rollback individual. Para rollback, v6 consulta antes de mutar la membresía real de `g6-po_g6_backend`; el Compose de restauración usa ese perfil anterior, no la selección nueva del manifiesto. La imagen solo se reporta restaurada si pasan health/readiness y el perfil anterior coincide. Si no se puede determinar la membresía o no se verifica el rollback, el ejecutor falla sin afirmar restauración completa. No se guarda URL, credencial ni configuración runtime como estado de rollback.

### Pruebas y alcance de CI

Pruebas enfocadas reproducibles en Linux:

```bash
bash -n ops/oracle/amqp-opt-in.sh ops/oracle/deploy-g6-service-v6.sh \
  ops/oracle/tests/amqp-opt-in.test.sh \
  ops/oracle/tests/deploy-g6-service-v6.test.sh \
  ops/oracle/tests/amqp-opt-out-compose.test.sh
bash ops/oracle/tests/amqp-opt-in.test.sh
bash ops/oracle/tests/deploy-g6-service-v6.test.sh
bash ops/oracle/tests/amqp-opt-out-compose.test.sh
bash ops/oracle/tests/deploy-g6-service.test.sh
bash ops/oracle/tests/deploy-inventory-svc.test.sh
```

`amqp-opt-out-compose.test.sh` crea una red Docker bridge y un contenedor efímeros, habilita AMQP mediante overlay, recrea sin él y comprueba que HTTP loopback sigue respondiendo. Requiere Docker Engine, Compose v2, `curl` y acceso a una imagen `nginx:alpine`; limpia el proyecto y la red al terminar.

**Resultado local al 6-nov-2026:** `amqp-opt-in.test.sh`, `deploy-g6-service-v6.test.sh` y `bash -n` pasaron en WSL; la prueba de Compose opt-out pasó con Docker Desktop, recreando el contenedor y verificando que HTTP seguía respondiendo. Las pruebas `deploy-g6-service.test.sh`, `deploy-inventory-svc.test.sh`, `deployment-api.test.sh` y `ensure-ghcr-sha-image.test.sh` pasaron en WSL; las comprobaciones que requieren Compose/daemon dentro de WSL informaron `NO EJECUTADO`. La prueba de Compose desechable sí se ejecutó con el daemon Docker Desktop de Windows.

**CI v6: BLOQUEADO por autorización de archivo transversal.** Backend #110 cubre composición de nueve componentes y #29 conectividad AMQP privada, pero ninguno autoriza expresamente modificar `.github/workflows/ci.yml`; AGENTS.md exige autorización del Issue para `.github/`. Por eso no se alteró el workflow ni se afirma que el job Oracle ejecute estas tres pruebas. La CI existente, incluso si está verde para el PR, no equivale a regresión v6. Owner de desbloqueo: Marco; operación: editar workflow compartido; condición: autorización explícita en un Issue y que el job Linux ejecute los comandos de arriba, incluidos `bash -n`.

## Instalación futura (no ejecutada)

Requiere autorización operativa específica de Marco, auditoría de solo lectura actual, ventana de mantenimiento y respaldo verificado. No ejecutar la siguiente lista como parte del desarrollo:

| Artefacto futuro | Ruta objetivo Oracle | Acción futura |
|---|---|---|
| `deploy-g6-service-v6.sh` | primero `/usr/local/lib/g6-productos-ofertas/deploy-g6-service-v6`; tras aprobación, `/usr/local/lib/g6-productos-ofertas/deploy-g6-service` | Instalar en ruta candidata, verificar v6/registro 2, respaldar v5 y hacer sustitución atómica del ejecutor activo. La ruta destino es la que usa el wrapper histórico de Inventory. |
| `amqp-opt-in.sh` | `/usr/local/lib/g6-productos-ofertas/amqp-opt-in.sh` | Instalar junto al ejecutor v6 porque se carga desde su directorio. |
| `docker-compose.service.amqp.yml` | `/opt/g6-productos-ofertas/shared/docker-compose.service.amqp.yml` | Instalar overlay genérico; se añade solo si el manifiesto contiene ese servicio. |
| `docker-compose.inventory.amqp.yml` | `/opt/g6-productos-ofertas/inventory/docker-compose.inventory.amqp.yml` | Instalar overlay dedicado sin sustituir `docker-compose.inventory.yml` ni su overlay HTTP. |
| Manifiesto AMQP | `/etc/g6-productos-ofertas/amqp-opt-in.psv` | Crear inicialmente con solo el encabezado (ningún servicio seleccionado); root-owned y legible para la cuenta de despliegue, sin escritura de grupo/otros. |
| `service-registry.sh`, `services.psv`, Compose base/HTTP/Gateway, wrappers, workflows | rutas actuales | No reemplazar por este candidato; registro v2, protocolos, HTTP, Gateway, Caddy y wrapper Inventory se mantienen. |

La instalación de helper/overlays/manifiesto y la sustitución del ejecutor requieren ventana para pausar despliegues automáticos/manuales y comprobar que no hay deploy concurrente. Activar un servicio exige otra liberación individual; solo se recrea ese proyecto Compose. No se requiere ventana para cambios de RabbitMQ porque no se cambia RabbitMQ ni sus redes aquí; la inspección previa debe confirmar el estado, y ante diferencia se detiene todo.

1. Confirmar SHA/código y pruebas locales obligatorias; registrar que CI actual aún no ejecuta la regresión v6. Resolver autorización para el workflow antes de declarar cobertura CI. Suspender temporalmente liberaciones concurrentes según el procedimiento de instalación existente. Respaldar con dueño, modo y SHA-256 los archivos del ejecutor v5, registro, Compose, wrapper y estado. No leer/imprimir valores runtime.
2. Inspeccionar `g6-po_g6_backend` y RabbitMQ actualmente: red, etiquetas, atributos, aliases, contenedor, puertos publicados y miembros. El preflight histórico no es evidencia actual. Si no coincide exactamente o AMQPS no está disponible para Pricing/Price Audit, no conectarlos; no crear/rediseñar redes en esta operación.
3. Asegurar un `runtime.env` por servicio con permisos `root:<grupo-del-servicio>` y lectura limitada al usuario de despliegue. Preparar URL, vhost y credenciales individuales desde un canal secreto. No almacenar valores en GitHub/Git ni mostrar en logs. Configurar flags de consumidores por separado después de aprobar cada capacidad.
4. Instalar como root, con ownership/modos revisados, `amqp-opt-in.sh`, los dos overlays, manifiesto vacío versión 1 y `deploy-g6-service-v6.sh` en ruta versionada de staging. Probar `--version` (`ejecutor=6 registro=2`) y Compose `config --quiet` para cada servicio permitido, base+HTTP+AMQP, sin `up` ni `pull`.
5. Solo con ventana y autorización, hacer reemplazo atómico del ejecutor activo desde respaldo v5 a candidato v6. No modificar `services.psv`, Compose base, wrapper Inventory, workflow, redes, RabbitMQ ni Gateway. Comparar checksums y probar `--version`.
6. Añadir un servicio cada vez al manifiesto, revisar permisos/valores sin imprimirlos y desplegar explícitamente solo ese servicio y SHA autorizado. Ejecutar readiness/health y prueba funcional aislada o de destino autorizada. El manifiesto por sí solo no autoriza despliegue, consumo, publicación ni cambios de topología.

## Reversión futura

La reversión planeada es por servicio: retirar la fila y redeplegar el SHA activo con base+overlay HTTP. En caso de fallo, v6 repone el perfil AMQP real que tenía el contenedor previo; si no puede verificar su perfil o health/readiness, informa rollback no verificado y detiene la secuencia. Confirma que la red AMQP desapareció y HTTP/readiness sigue sano. Para restablecer ejecutor v5, restaurar atómicamente su copia respaldada y verificar su checksum/`--version`; v5 no lee el manifiesto ni agrega overlay AMQP. No eliminar red, contenedor/volumen RabbitMQ, credenciales, colas ni bindings. No usar `down -v`, `--remove-orphans`, prune o comandos globales. Inventory usa su proyecto `g6-inventory` y Compose legacy.

Si un rollback automático de imagen falla, aplicar el runbook actual de rollback individual, mantener la red RabbitMQ intacta y detener nuevos opt-ins. Restaurar v5 requiere la autorización de ventana definida; no debe hacerse a mitad de una operación de reemplazo sin comprobar primero los miembros de red.

## Estado y bloqueos

- Implementación interna de archivos de preparación: candidata en rama, sujeta a pruebas y revisión.
- Configuración AMQP / red actual: no auditada en Oracle por esta tarea.
- Integración autenticada, permisos, topología y homologación externa: pendientes por servicio.
- Deploy, activación productiva, CI de `master`, smoke Oracle y E2E compartido: no ejecutados ni afirmados.
- Retry/DLX: BLOQUEADO_ESPECÍFICO; no forma parte del candidato.
- Responsable por operación productiva: Marco/infra; condición de desbloqueo: autorización individual, inspección de red actual, identidad/ACL mínima, compatibilidad de AsyncAPI/topología y prueba autenticada desde contenedor con evidencia ligada al SHA.
