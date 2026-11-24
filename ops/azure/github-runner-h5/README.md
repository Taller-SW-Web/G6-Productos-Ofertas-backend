# Runner privado H5: estado y recuperación

Evidencia recogida el 2026-11-23 para `G6-Productos-Ofertas-backend`. No se crearon recursos Azure persistentes ni se modificaron protecciones de GitHub; se lanzaron dos ejecuciones de diagnóstico del Job existente.

## Hallazgos verificados

- El host runner previamente reportado estaba offline y no fue recuperado. En la verificación actual, la API del grupo 3 devuelve cero runners; no hay runner online registrado.
- El runner está asignado al grupo `g6-h5-private-smoke` (ID `3`), visibilidad `selected`, restringido al único workflow `Taller-SW-Web/G6-Productos-Ofertas-backend/.github/workflows/cd-services-azure.yml@refs/heads/master`. GitHub informa `allows_public_repositories=true`; el repositorio G6 también es público. No se ampliaron repositorios/workflows ni se alteró la regla del grupo.
- `azure-h5` existe. La API confirma reviewers `AXL031` y `MiguelTacoZavala`, `prevent_self_review=true`, `can_admins_bypass=false` y la única policy `master`. No se cambió ninguna protección.
- Las variables OIDC `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` y `AZURE_SUBSCRIPTION_ID` existen. La identidad administrada `g6-h5-int-github-cd` tiene client ID `980a22b5-1429-4ffe-9707-de0d0f5b68d2`, principal ID `04f4ebe2-e5fa-4056-85d8-4262fcab658e`. Su federated credential `github-azure-h5` coincide con issuer `https://token.actions.githubusercontent.com`, audience `api://AzureADTokenExchange` y subject `repo:Taller-SW-Web/G6-Productos-Ofertas-backend:environment:azure-h5`.
- ARM no devolvió role assignments para ese principal a nivel de suscripción ni del RG `rg-g6-sb-h5-int-fork`. La identidad federada está lista, pero el CD Azure no tiene RBAC efectivo comprobado. Los comandos de Microsoft Graph para listar enterprise app credentials no están autorizados para el usuario CLI; ARM sí permitió inspeccionar la identidad y la credencial federada del UAMI.
- `env-g6-h5-int` está `Succeeded`, región Brazil South, Consumption, `publicNetworkAccess=Disabled`, `vnetConfiguration=null`, sin configuración de DNS personalizada reportada. No se pudo demostrar que sea un Environment interno unido a VNet: no hay VNet/subred en el resource group H5. La única VNet encontrada en la suscripción está en `chilecentral`, sin peering al Environment; su VM está deallocated, tiene IP pública y el NSG permite HTTP/HTTPS desde `*`, por lo que no es un runner seguro reutilizable.
- El Container Apps Job `azure-h5-smoke` existe en ese Environment: manual, Consumption (0.5 CPU, 1 GiB), `identity=None`, imagen oficial fijada por digest e invoca `run.sh --jitconfig`. Se inspeccionaron las dos ejecuciones fallidas `azure-h5-smoke-euo3roc` y `azure-h5-smoke-e4qwsko`: ambas `Failed`, `BackoffLimitExceeded`, contenedor `runner` `Terminated`, exit code `1`, `ProcessExited`. La primera tuvo argumentos de diagnóstico incorrectos; la segunda sí usó el override esperado y también terminó en exit 1. `az containerapp job logs show` está disponible en la extensión `containerapp` 1.3.0b6, pero la lista de réplicas de ambas ejecuciones está vacía y el comando devuelve 404 `ExecutionReplicaNotFound`; no se puede identificar la causa subyacente. No se atribuye a DNS, GitHub ni permisos. El Environment no tiene destino Log Analytics configurado; no se creó uno. No hay runner JIT online actualmente.
- No existen `api-gateway`, `catalog-svc`, `inventory-svc`, `pricing-svc` ni `promotions-svc` como ACA en el RG consultado. Por tanto no hay FQDN vivo con el que probar DNS/TLS, ni se declara smoke HTTP PASS. No se abrieron servicios a Internet.
- Las cinco variables `AZURE_SMOKE_URL_*` y sus cinco `AZURE_SMOKE_PROTECTED_*` están configuradas en `azure-h5`. Gateway se actualizó al origen privado esperado `https://api-gateway.internal.greenriver-1cd78197.brazilsouth.azurecontainerapps.io`; los otros cuatro usan el mismo patrón `*.internal`. Pricing usa GET `/api/v1/precios`. Los cinco FQDN se derivan del sufijo/dominio ACA observado, pero ninguno fue validado por DNS/TLS porque las aplicaciones no existen. GitHub conserva solo el hostname de Gateway configurado como privado para la futura prueba.
- Rutas protegidas actuales: Gateway y Promotions `/api/v1/promociones/administracion`; Catalog `/api/v1/productos/administracion`; Inventory `/api/v1/inventario/administracion/saldos`; Pricing `/api/v1/precios`. Son GET documentados en OpenAPI de Docs `master`; Pricing usa seguridad `userBearer` o `serviceBearer`. El smoke HTTP actual no enviará credenciales y debe seguir verificando la respuesta 401/403 según su implementación. La API de Docs es semifinal y la aceptación externa/grants no se infieren.

## Recuperación autorizada y preflight

1. `verify-runner-group.ps1` vuelve a comprobar en solo lectura que el grupo 3 solo permite este repo/workflow de `master`, y que `azure-h5` sigue con reviewers, no autoaprobación, `master` y sin bypass. La comprobación del 2026-11-23 confirmó por `deployment-branch-policies` exactamente una policy: `master`.
2. `run-container-preflight.ps1` inicia una ejecución no persistente del Job existente para comprobar herramientas, HTTPS a GitHub/GHCR, clone del código y fallo cerrado del smoke sin URL (no hace HTTP a ACA). Tiene coste variable de cómputo/transferencia. El diagnóstico captura estado detallado, réplica, contenedor, exit code y disponibilidad de logs; cuando la plataforma ya limpió las réplicas, registra `BLOCKED_NO_EXECUTION_LOGS` junto al nombre de ejecución.
3. `aca-job-secret-patch.ps1` usa únicamente PATCH mínimo de `properties.configuration.secrets` en Microsoft.App/jobs API `2025-07-01`; no tiene fallback PUT. Maneja 200, 202/LRO, ETag condicional, lectura posterior y limpieza verificada. La lectura real del Job devolvió HTTP 200 pero no ETag; el flujo omite `If-Match` cuando ARM no lo expone. Las pruebas simuladas cubren éxito 200, LRO 202, conflicto ETag, 400 con campos de error limitados/redactados, timeout, fallo de inicio y limpieza fallida.
4. La respuesta anterior HTTP 400 del PUT integral no conservó el detalle del error, así que no puede atribuirse a un campo concreto. En esta revisión, la solicitud JIT verificada se serializó con `labels:["h5-runner-preflight-only"]` y `runner_group_id:3`; GitHub la aceptó y registró temporalmente el runner offline. Una ejecución anterior del runbook se detuvo al interpretar la respuesta; tras corregirlo, una segunda alcanzó el PATCH, pero la espera LRO falló al encontrar una respuesta Azure sin la propiedad `status`. El runner efímero se borró. No hay ejecución ACA nueva y un GET ARM final confirma que no queda ningún nombre de secreto; no se pudo confirmar el readback posterior al PATCH de alta.
5. `aca-job-secret-patch.ps1` acepta `status`, `provisioningState`, `properties.provisioningState` y un 200 terminal sin estado, seguido siempre por readback del recurso. Estas variantes están simuladas. La reconciliación de solo lectura del 2026-11-23 confirmó que el runner ID 42 devuelve 404 en GitHub, el grupo autorizado tiene cero runners, el Job no presenta nombres de secretos (`configuration.secrets=null`) y la lista de ejecuciones no incluye estados activos ni desconocidos. No hay ejecución CD en curso. Azure Activity Log conserva para las dos escrituras del Job solo `Started`/`Accepted`, sin estado terminal ni URI de operación; el GET del Job informa `provisioningState=Succeeded` y ausencia del secreto, pero no permite consultar retrospectivamente el estado LRO exacto. El marcador local `CLEANUP_INCOMPLETE` permanece intacto y bloquea cualquier nuevo JIT hasta que el operador lo retire manualmente tras revisar esta evidencia.
6. Antes de enviar el JIT, el runbook persiste el nombre efímero en `JIT_ATTEMPT.json`; `finally` reconcilia ese nombre exacto aunque falte el ID o la respuesta sea ambigua. Los estados ACA activos, desconocidos o no verificables bloquean el cleanup. Un PATCH ambiguo conserva el bloqueo y evita otro PATCH hasta reconciliarlo. El marcador previo se conserva; no hay `JIT_ATTEMPT.json` pendiente de esta revisión.
7. `run-jit-registration-preflight.ps1` mantiene modo `Diagnostic` (etiqueta exclusiva `h5-runner-preflight-only`) y modo `Smoke` sin despacho automático. Smoke verifica el workflow oficial, SHA actual de master, despliegues exitosos en `azure-h5` y recorre los jobs matrix secuencialmente: observa el `runner_id` asignado, espera la conclusión del job y la ejecución ACA correlacionada, y limpia antes del siguiente JIT. Las pruebas simuladas cubren una y cinco tareas, asignación inesperada, fallo intermedio y limpieza incompleta. No se usó modo Smoke ni se ejecutó el CD oficial.
8. `prepare-cd-rbac.ps1` compara tipo de rol custom, Actions, NotActions, DataActions, NotDataActions y AssignableScopes exactos; lista asignaciones heredadas para bloquear permisos inesperados. No aplica RBAC hasta existir las cinco ACA y autorización explícita. La consulta actual no muestra asignaciones; la aplicación sigue bloqueada por las ACA ausentes.
9. Chat 1 implementa el IaC de las cinco ACA; el despliegue operativo de esas aplicaciones corresponde al Chat 6. Cuando las ACA estén desplegadas, ejecutar `probe-private-endpoint.sh` desde el runner registrado para cada URL privada. El script comprueba DNS y certificado TLS y no hace HTTP. Después, una vez aprobadas las imágenes/targets, Chat 6 podrá ejecutar el workflow oficial para validar liveness, readiness y el GET protegido con aprobación humana. DNS/TLS PASS no es smoke HTTP PASS.
10. Confirmar que Gateway también apunte al FQDN privado confirmado por el owner de ingress. No habilitar ingress público para resolver un fallo del runner.

## Diagnóstico DNS/TLS y red externa G5

La separación deseada es: runner efímero en `env-g6-h5-int` → DNS interno y TLS de Gateway/ACA → luego HTTP smoke; y, por separado, G5 → punto de entrada privado aprobado → Gateway. Actualmente no hay ACA ni prueba DNS/TLS/HTTP real (`NOT_RUN`). El Gateway configurado con ingress interno solo sirve el límite de red del Environment; un cliente G5 externo no queda homologado por el smoke interior.

La topología externa requiere que el owner de red apruebe una VNet cliente alcanzable por G5 mediante peering/VPN/ExpressRoute, rutas/NSG limitadas a 443 y resolución privada. Las opciones a evaluar son un Private Endpoint de APIM con private DNS más conectividad privada de APIM hacia el backend, o un Private Endpoint del ACA Environment y DNS correspondiente. Azure documenta que los ACA Private Endpoints requieren Environment de workload profiles y subnet para PE de al menos `/27`; el Environment existente se reportó Consumption y no tiene VNet configurada, por lo que esa opción no se puede dar por habilitada. APIM Private Endpoint requiere DNS privado al IP del endpoint y solo habilita tráfico entrante al Gateway; la ruta APIM→ACA aún necesita su propia conectividad privada. No se creó VNet, peering, PE ni ingress público.

## Pruebas reproducibles

Desde Linux con Bash, `getent`, `openssl`, `timeout` y ripgrep:

```bash
bash ops/azure/github-runner-h5/tests/probe-private-endpoint.test.sh
bash ops/azure/github-runner-h5/probe-private-endpoint.sh https://<fqdn-privado-confirmado>
```

La prueba unitaria simula resolución DNS y handshake TLS; no acredita conectividad Azure. El segundo comando solo se ejecuta en el runner de red autorizada después de que el FQDN exista. No usarlo para declarar un smoke HTTP exitoso.

Validaciones locales auxiliares: `bash ops/azure/github-runner-h5/tests/workflow-authorization.test.sh` verifica estáticamente el disparador manual, selector del runner privado y ambiente de smoke; `python ops/azure/github-runner-h5/tests/test-render-execution-template.py` prueba la conversión segura a YAML; `verify-runner-group.ps1` hace verificaciones de configuración GitHub en vivo. El preflight valida Git/Node y transportes, pero no ejecuta la acción `actions/checkout`; probarla realmente requiere una ejecución del CD oficial, que no se inició. Ejecutar scripts PowerShell desde la raíz del repositorio.

## Costes / límites

No se crearon recursos persistentes. Se lanzaron dos ejecuciones preflight fallidas del Job Consumption, con posible cargo por cómputo mínimo, además de la transferencia de imagen/GitHub; no se calculó una tarifa. Las ejecuciones futuras pueden generar cargos por cómputo, transferencia, GHCR, DNS privado, Private Endpoint y logs según diseño/región. El Environment y otros recursos preexistentes podrían generar costos fuera de esta tarea.

## Recuperación de PATCH/LRO y bloqueo histórico (2026-11-24)

### Operación histórica

El recurso investigado en solo lectura fue exactamente `/subscriptions/fef42188-accd-4470-ae88-78f583eb4906/resourceGroups/rg-g6-sb-h5-int-fork/providers/Microsoft.App/jobs/azure-h5-smoke`, en la suscripción `fef42188-accd-4470-ae88-78f583eb4906`. Activity Log conserva dos correlaciones de `Microsoft.App/jobs/write` con `Started` y `Accepted`, pero sin evento terminal ni URI `Azure-AsyncOperation`/`Location`:

| Correlation ID | Started (UTC), eventDataId | Accepted (UTC), eventDataId |
|---|---|---|
| `f22d607f-842f-4147-aeac-2d817e13dc64` | `2026-11-24T00:00:21.292604Z`, `85cbfb08-f7f1-46e0-8852-25e217c52d47` | `2026-11-24T00:00:24.0426133Z`, `3a451a66-e991-46dd-b5f5-574fe32ef4c8` |
| `706a114c-738d-43bb-a8b3-5f505514e3f8` | `2026-11-24T00:00:29.6923187Z`, `af38f8c3-0f4d-4270-a46a-befbc8f5c508` | `2026-11-24T00:00:30.3485694Z`, `e1cc87c1-85ae-4e0c-b707-48fca83d28d2` |

The Activity Log request client IDs were empty and supplied no ARM request IDs for these events. Local shell history and local attempt files contain no matching request IDs or operation references. The exact operation cannot be polled or reconstructed from these records. Its permanent classification is **`HISTORICAL_LRO_UNVERIFIABLE`**; the Job's current `provisioningState=Succeeded` does not prove the old operation's result. Azure's supported async-operation polling requires the exact URL returned in the original response; do not synthesize one from a correlation ID. See [Microsoft's ARM asynchronous operation guidance](https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/async-operations).

### Current-state observations (not historical LRO proof)

Two read-only snapshots were compared while no operator initiated a write. Observation 1 completed `2026-11-24T01:56:16.7182175Z`; observation 2 ran `2026-11-24T02:05:49.9072419Z`–`02:06:10.9311689Z`, over nine minutes later. Both showed:

- Correct subscription, resource group, Job name and Environment ID; ARM reports `provisioningState=Succeeded`.
- Job template remained the pinned runner image with the approved `/bin/bash -c` JIT entrypoint; no unexpected persistent command or environment override was observed.
- No `h5jit` secret or secret reference. ARM represents the empty secrets collection as `null`.
- All eight listed executions were terminal (`Succeeded` or `Failed`); none was active or indeterminate.
- Authorized GitHub runner group 3 returned `total_count=0`; historical runner ID 42 returned HTTP 404.
- No queued/running CD workflow was found. The marker SHA256 remained `3D2140E1856659A5AF72788B2828812895462E26DD14138ED192930DE874825E`.
- No candidate sensitive temporary file was found in the local temp directory. Activity Log has no later write for either of the two historical correlations.

These observations describe only the resource state at those times. They are not proof that an older ARM LRO cannot later apply a change. The existing `%LOCALAPPDATA%\G6\azure-h5-smoke\CLEANUP_INCOMPLETE.json` was not changed. An authorized Azure subscription owner must record a formal confirmation that no pending operation for this resource can subsequently alter the Job, or obtain an Azure Support determination. Supply the exact resource, two correlation IDs, four eventDataIds and timestamps above. If support must be engaged, the subscription owner should open the case and retain its case ID and written disposition. Only after that review may the human operator assess and manually remove the marker; this runbook never removes, renames, edits or bypasses it. No JIT attempt is authorized while it exists.

### Durable local tracking for future PATCH operations

`aca-job-secret-patch.ps1` now writes a JSON Lines journal at `%LOCALAPPDATA%\G6\azure-h5-smoke\patch-lro-tracking\operations.jsonl` before a PATCH and after each response, poll, terminal state and readback. Windows ACLs are restricted to the current user's SID; non-Windows permissions are set to `0700` on the directory and `0600` on the file. The journal contains attempt ID, UTC timestamps, exact resource path, operation, HTTP status, ARM request/correlation IDs, any exact LRO reference returned by ARM, terminal state and readback status. It never stores the ARM bearer token, Authorization header, JIT configuration or secret values. An LRO reference is treated as sensitive and remains only in that ACL-restricted local journal.

An interrupted/ambiguous operation remains a hard gate for subsequent PATCHes. With the same authorized Azure CLI subscription and local user profile, an operator can run:

```powershell
pwsh -NoProfile -File ops/azure/github-runner-h5/resolve-patch-journal.ps1
```

The resolver polls only the exact persisted LRO reference and verifies the Job readback. If no exact LRO reference was persisted, it reports `HISTORICAL_LRO_UNVERIFIABLE` and preserves the block; it will not guess an operation URI. Keep the journal and marker until reconciliation and authorized human review are complete.
