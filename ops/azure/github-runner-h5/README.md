# Runner privado H5: estado y recuperación

Evidencia de solo lectura recogida el 2026-11-23 para `G6-Productos-Ofertas-backend`. No se crearon recursos Azure ni se modificaron protecciones de GitHub.

## Hallazgos verificados

- El runner organizacional `azure-h5-smoke` existe (runner ID `33`), está `offline`, no ocupado, Linux X64, versión informada `2.338.2`; etiquetas `self-hosted`, `Linux`, `X64`, `azure-h5-smoke`. No se pudo recuperar directamente porque el host no está online.
- El runner está asignado al grupo `g6-h5-private-smoke` (ID `3`), visibilidad `selected`, restringido al único workflow `Taller-SW-Web/G6-Productos-Ofertas-backend/.github/workflows/cd-services-azure.yml@refs/heads/master`. GitHub informa `allows_public_repositories=true`; el repositorio G6 también es público. No se ampliaron repositorios/workflows ni se alteró la regla del grupo.
- `azure-h5` existe. La API confirma reviewers `AXL031` y `MiguelTacoZavala`, `prevent_self_review=true`, `can_admins_bypass=false` y la única policy `master`. No se cambió ninguna protección.
- Las variables OIDC `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` y `AZURE_SUBSCRIPTION_ID` existen. La identidad administrada `g6-h5-int-github-cd` tiene client ID `980a22b5-1429-4ffe-9707-de0d0f5b68d2`, principal ID `04f4ebe2-e5fa-4056-85d8-4262fcab658e`. Su federated credential `github-azure-h5` coincide con issuer `https://token.actions.githubusercontent.com`, audience `api://AzureADTokenExchange` y subject `repo:Taller-SW-Web/G6-Productos-Ofertas-backend:environment:azure-h5`.
- ARM no devolvió role assignments para ese principal a nivel de suscripción ni del RG `rg-g6-sb-h5-int-fork`. La identidad federada está lista, pero el CD Azure no tiene RBAC efectivo comprobado. Los comandos de Microsoft Graph para listar enterprise app credentials no están autorizados para el usuario CLI; ARM sí permitió inspeccionar la identidad y la credencial federada del UAMI.
- `env-g6-h5-int` está `Succeeded`, región Brazil South, Consumption, `publicNetworkAccess=Disabled`, `vnetConfiguration=null`, sin configuración de DNS personalizada reportada. No se pudo demostrar que sea un Environment interno unido a VNet: no hay VNet/subred en el resource group H5. La única VNet encontrada en la suscripción está en `chilecentral`, sin peering al Environment; su VM está deallocated, tiene IP pública y el NSG permite HTTP/HTTPS desde `*`, por lo que no es un runner seguro reutilizable.
- El Container Apps Job `azure-h5-smoke` sí existe en el Environment anterior. Es un job manual de Consumption (0.5 CPU, 1 GiB), `identity=None`, imagen del runner fijada por digest, invoca `run.sh --jitconfig` y tiene `Executions=0` en las métricas consultadas. Es un candidato de cómputo efímero, pero no prueba registro en GitHub ni acceso a DNS/targets privados. El job comparte el Environment sin VNet; solo una prueba posterior desde un runner registrado podrá demostrar DNS/TLS a los destinos reales.
- No existen `api-gateway`, `catalog-svc`, `inventory-svc`, `pricing-svc` ni `promotions-svc` como ACA en el RG consultado. Por tanto no hay FQDN vivo con el que probar DNS/TLS, ni se declara smoke HTTP PASS. No se abrieron servicios a Internet.
- Las cinco variables `AZURE_SMOKE_URL_*` y sus cinco `AZURE_SMOKE_PROTECTED_*` están configuradas en `azure-h5`. Pricing se completó durante esta tarea: URL interna derivada del dominio/nombre ACA observado (`https://pricing-svc.internal.greenriver-1cd78197.brazilsouth.azurecontainerapps.io`) y ruta GET contractual `/api/v1/precios`. El host de Pricing sigue pendiente de validación tras crear ACA. La URL existente de Gateway no incluye `.internal`; el ingress/FQDN privado debe confirmarse con el equipo que administra las ACA antes de dar red lista.
- Rutas protegidas actuales: Gateway y Promotions `/api/v1/promociones/administracion`; Catalog `/api/v1/productos/administracion`; Inventory `/api/v1/inventario/administracion/saldos`; Pricing `/api/v1/precios`. Son GET documentados en OpenAPI de Docs `master`; Pricing usa seguridad `userBearer` o `serviceBearer`. El smoke HTTP actual no enviará credenciales y debe seguir verificando la respuesta 401/403 según su implementación. La API de Docs es semifinal y la aceptación externa/grants no se infieren.

## Recuperación autorizada

1. El owner del host debe recuperar o retirar el runner ID `33` sin cambiar el nombre, grupo ni `azure-h5-smoke`. Si no hay host recuperable, usar el Container Apps Job existente solo después de que el owner de red confirme el alcance privado del Environment y el owner GitHub genere una configuración JIT para el runner efímero del grupo `3`. La configuración JIT es credencial efímera: no ponerla en argumentos de shell persistentes, artifacts, summary ni logs; borrarla al terminar la ejecución y registrar el runner efímero como eliminado/offline esperado.
2. Mantener el grupo restringido al workflow CD en `master`. No habilitar repositorios públicos adicionales ni registrar un runner persistente con acceso a la red interna. El job JIT debe ejecutar una tarea segura de diagnóstico sin secretos; no iniciar el CD oficial mientras falten apps o imágenes.
3. Cuando Chat 1 cree las cinco ACA, ejecutar `probe-private-endpoint.sh` desde el runner registrado para cada URL privada. El script comprueba DNS y certificado TLS y no hace HTTP. Después, una vez aprobadas las imágenes/targets, el workflow oficial valida liveness, readiness y el GET protegido. DNS/TLS PASS no es smoke HTTP PASS.
4. Confirmar que Gateway también apunte al FQDN privado confirmado por el owner de ingress. No habilitar ingress público para resolver un fallo del runner.
5. Tras crear los recursos, definir los dos roles de mínimo privilegio de esta carpeta. Crear `role-aca-existing-apps.json`, asignar `G6 H5 Existing Container Apps Operator` **solo en el scope de cada ACA ya existente** (nunca en RG/subscription), y crear/asignar `role-aca-environment-reader.json` al RG. El scope del rol de apps limita el permiso `containerApps/write` a apps existentes y no concede `delete`; el rol de lectura no incluye escrituras. Los scopes específicos evitan conceder capacidad de creación de ACA. Antes de crear roles, confirmar acciones con `az provider operation show --namespace Microsoft.App` y `--namespace Microsoft.Resources` junto al owner RBAC. Asignar después en scopes de `api-gateway`, `catalog-svc`, `inventory-svc`, `pricing-svc` y `promotions-svc`; agregar otra ACA solo si su CD se autoriza. Finalmente comprobar `az role assignment list --assignee-object-id 04f4ebe2-e5fa-4056-85d8-4262fcab658e --all`. No se asignó rol porque las ACA todavía no existen.

## Pruebas reproducibles

Desde Linux con Bash, `getent`, `openssl`, `timeout` y ripgrep:

```bash
bash ops/azure/github-runner-h5/tests/probe-private-endpoint.test.sh
bash ops/azure/github-runner-h5/probe-private-endpoint.sh https://<fqdn-privado-confirmado>
```

La prueba unitaria simula resolución DNS y handshake TLS; no acredita conectividad Azure. El segundo comando solo se ejecuta en el runner de red autorizada después de que el FQDN exista. No usarlo para declarar un smoke HTTP exitoso.

## Costes / límites

No se creó ningún recurso ni se ejecutó el Container Apps Job; las métricas consultadas reportaron cero ejecuciones. Una ejecución futura de Consumption puede generar cargos por cómputo, transferencia, GHCR y logs según uso/región; no se calculó una tarifa ni estimación numérica. El Environment y otros recursos preexistentes podrían generar costos fuera de esta tarea.
