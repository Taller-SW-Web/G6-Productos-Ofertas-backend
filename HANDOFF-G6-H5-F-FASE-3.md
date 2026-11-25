# HANDOFF — G6-H5-F Fase 3: preparación operativa Chile

Fecha: 2026-11-24 (America/Lima)
Backend `origin/master`: `1bd4d4c296521fa4ed20a9552985fe9aa930f688` (PR #270 merge commit). Los scripts operativos ejecutados desde el worktree en `c6be06c4d0b275372b3ded6443caea16b1efee52` coinciden con los archivos correspondientes de `origin/master`. No se cambió código ni se creó PR.

## Addendum — Fase 3B (estado actualizado)

Este addendum supersede los bloqueos de RBAC, cuota, Job y JIT descritos abajo cuando difieran. `origin/master` consultado: `c73ed61c533a21787d1dab22aa79cd83ff77da14`. El gate `AZURE_CHILE_DEPLOY_ENABLED` sigue `false`. No se modificaron las ACA de microservicios ni su tráfico/configuración.

### Corrección RBAC y Draft PR

- Draft PR [#272](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/pull/272), rama `fix/h5-rbac-lectura-revisiones-chile`, HEAD `47e90bd4ac3ae640506106ec1bd0f8ab4999a302`, base `master`.
- Cambio exacto en `role-aca-existing-apps-chile.json`: agrega `Microsoft.App/containerApps/revisions/read`; conserva `containerApps/read`, `containerApps/write`, `NotActions: containerApps/delete`, scope asignable RG placeholder y asignaciones por ACA individual. La prueba compara el allowlist exacto de las tres acciones. Brasil no fue modificado.
- Suficiencia de operaciones de `deploy.sh`: `az group show` usa `Microsoft.Resources/subscriptions/resourceGroups/read`; ACA Environment requiere `Microsoft.App/managedEnvironments/read`; ACA `show` requiere `Microsoft.App/containerApps/read`; `revision show` requiere la nueva acción `Microsoft.App/containerApps/revisions/read`; `containerapp update` requiere `Microsoft.App/containerApps/write`. La consulta `az provider operation show --namespace Microsoft.App` confirma que la lectura de revisiones es una acción separada. No encontré otra acción Azure de escritura/lectura de ACA indispensable en `deploy.sh` que falte en el conjunto planificado; no se añadieron permisos de modificación de revisiones.
- Validaciones: `pwsh -NoProfile -File ops/azure/github-runner-h5/tests/test-rbac-plan.ps1` PASS; JSON `ConvertFrom-Json` PASS; PowerShell parser de la prueba PASS; `git diff --check` PASS. No hubo RBAC Apply. CI del Draft aún no se considera validada.

### Cuotas, presupuesto y Job

Consultas oficiales ejecutadas en suscripción explícita:

| Consulta | Resultado | Interpretación |
|---|---|---|
| `az containerapp env list-usages -g rg-g6-aca-chile -n env-g6-phase1-chile` | `ManagedEnvironmentConsumptionCores`: uso 2, límite 100 | Hay cores Consumption reportados; esta métrica no es una cuota de Jobs. |
| `az containerapp list-usages -l chilecentral` | `Managed Environment Count`: 1/1; `Session Pools`: 0/1; `Express Environment Count`: 0/1; `Sandbox Cores`: 0/10 | El Environment count está al límite, pero no impide crear un Job en el Environment existente. La respuesta no expone cuotas de cantidad de Jobs ni ejecuciones simultáneas. No se interpretó lo desconocido como agotado. |

El coordinador autorizó creación y una única ejecución diagnóstica con consumo mínimo aunque el saldo exacto no sea visible. No se leyó el saldo del portal; no se atribuye monto/costo conocido. Un Job manual idle no mantiene una ejecución activa; la ejecución diagnóstica sí puede generar cargos de Consumption, sin importe comprobado.

Se creó el único Job autorizado `azure-h5-smoke-chile` por ARM API `Microsoft.App/jobs` versión `2024-03-01`, en el RG y Environment existentes. GET posterior: Resource ID `/subscriptions/fef42188-accd-4470-ae88-78f583eb4906/resourceGroups/rg-g6-aca-chile/providers/Microsoft.App/jobs/azure-h5-smoke-chile`, región `Chile Central`, `provisioningState=Succeeded`, Environment `env-g6-phase1-chile`, Consumption, trigger Manual, parallelism/completion `1/1`, timeout 1800 s, retry 0, contenedor único `runner`, imagen oficial fijada `ghcr.io/actions/actions-runner@sha256:4037925f16bd0626196684aff1853dabd242675c82efe08f0a2d376694738d19`, 0.5 CPU/1 GiB, comando `/bin/bash -c` compatible con `run.sh --jitconfig`, identity `None`, sin secreto persistente. No se ejecutó automáticamente al crearlo.

### Configuración smoke: cinco servicios

La configuración GitHub preexistente de Catalog e Inventory se conserva. No se enviaron solicitudes HTTP ni se modificaron variables de seguridad ACA.

| Servicio | Evidencia del artefacto y ruta | Seguridad efectiva | FQDN ACA | Variable smoke en `azure-h5-chile` |
|---|---|---|---|---|
| Catalog | Revisión `catalog-svc--b80jpbt`; digest `sha256:7bdb66c1bb94de9861f2c930eb6d7c899730b60fac3457785e1ac71ed766079e`; source SHA `9e4ac0af2a3ea882784413401bd5016ff611caa2`; GET `/api/v1/productos/administracion`; contrato `userBearer` | `CatalogAuthGuard` + identidad user y rol `GESTOR_COMERCIAL` | `catalog-svc.internal.calmgrass-aec0b33c.chilecentral.azurecontainerapps.io` | Configurada previamente: URL y ruta protegida. |
| Inventory | Revisión `inventory-svc--http-4c40b31b-mwgil3mw`; digest `sha256:d41a9d0a3b91f8619731c7099af6dd4521ddbf97fa088baa9039b09b03143ab6`; source SHA `4c40b31b8a12335d4018861ab6d94cfd69536d7b`; GET `/api/v1/inventario/administracion/saldos`. Docs `origin/master` SHA `40524e96c6973f84d74160076781702fe2a3da19`, path OpenAPI `/inventario/administracion/saldos` (server base `/api/v1`), operation `listarSaldosFisicosAdministracion`, líneas 19397–19408 | OpenAPI: `userBearer`, rol `GESTOR_COMERCIAL` y menciona capacidad autorizada. Runtime del SHA servido y master: `UserAuthGuard`, Bearer requerido y rol `GESTOR_COMERCIAL`; el handler no declara una capacidad adicional nombrada. Esta diferencia de capacidad queda documentada; el coordinador confirmó como requisito del smoke `userBearer` + `GESTOR_COMERCIAL`. | `inventory-svc.internal.calmgrass-aec0b33c.chilecentral.azurecontainerapps.io` | Configurada previamente: URL y ruta protegida. No se probó HTTP. |
| Gateway | Revisión `api-gateway--mktrestore1124`; digest `sha256:2ec4f28ee02c222f5e407caf5ecbd2aae13a158ed3ab1b9509cc6dedb778eed3`; source SHA `4c40b31b8a12335d4018861ab6d94cfd69536d7b`; GET `/api/v1/promociones/administracion`; contrato `userBearer` | Gateway permite bypass de lectura solo en modo `PUBLIC_READ_ONLY` y operation ID habilitado. `G6_SECURITY_MODE` y `GATEWAY_PUBLIC_OPERATION_IDS` son refs de secreto `e-g6-security-mode` y `e-gateway-public-operation-ids`; `az containerapp secret list` no reveló valores. Mode y pertenencia a allowlist `NOT_VERIFIED`. | `api-gateway.calmgrass-aec0b33c.chilecentral.azurecontainerapps.io` externo | No configurada; requiere mode efectivo autenticado y operation ID no público confirmados. |
| Pricing | Revisión `pricing-svc--0000004`; digest `sha256:78852699924a1410382d0dd7fff83ae0ae09601aa10c8ca22f9442fd27293048`; source SHA `9e4ac0af2a3ea882784413401bd5016ff611caa2`; GET `/api/v1/precios`; contrato `userBearer` | `PricingReadGuard`; lectura pública solo con `PUBLIC_READ_ONLY` y `consultarPrecios` en allowlist. Refs `g7-mode`/`public-ops-empty`; el proveedor no entrega los valores. Mode y allowlist `NOT_VERIFIED`. | `pricing-svc.internal.calmgrass-aec0b33c.chilecentral.azurecontainerapps.io` | No configurada; misma comprobación pendiente. |
| Promotions | Revisión `promotions-svc--http-4c40b31b-mwgj2k1j`; digest `sha256:82c272907449ab290ff7d4239b0a5805e54ed04908bd756479ed899cbd61d143`; source SHA `4c40b31b8a12335d4018861ab6d94cfd69536d7b`; GET `/api/v1/promociones/administracion`; contrato `userBearer` | `PromotionsQueryGuard`; lectura pública solo con `PUBLIC_READ_ONLY` y `listarPromocionesAdmin` en allowlist. Refs `e-g6-security-mode`/`e-promotions-public-operation-ids`; valores no legibles mediante CLI. Mode y allowlist `NOT_VERIFIED`. | `promotions-svc.internal.calmgrass-aec0b33c.chilecentral.azurecontainerapps.io` | No configurada; misma comprobación pendiente. |

El intento autorizado de inspección de secretos mostró solo referencias/nombres, no valores; no se imprimió ni alteró secreto alguno. Owner de runtime debe confirmar de forma sanitizada modo efectivo y `true/false` de allowlist para las tres rutas. No se abrió auth ni se configuraron URLs sin esa evidencia.

### Diagnóstico JIT único y Marketplace

Antes del ciclo se verificaron: Job `Succeeded`, cero ejecuciones, runner group 3 vacío, protecciones Environment correctas, `AZURE_CHILE_DEPLOY_ENABLED=false`, cero workflows CD queued/in progress, sin deployments Chile, sin `JIT_ATTEMPT.json`/`CLEANUP_INCOMPLETE.json`, y `Assert-AcaPatchJournalReady` PASS. El coordinador autorizó el diagnóstico sin esperar el resultado funcional del retest Marketplace.

Se ejecutó una vez `pwsh -NoProfile -File ops/azure/github-runner-h5/run-jit-registration-preflight.ps1 -Destination chile-shared -Mode Diagnostic` desde un worktree detached exactamente en `origin/master` SHA `c73ed61c533a21787d1dab22aa79cd83ff77da14`. GitHub aceptó el runner `h5-jit-preflight-4b3f4331cb`, ID 57, label exclusiva `h5-runner-preflight-only`; se observó online y sin etiquetas smoke. La ejecución ACA correlacionada `azure-h5-smoke-chile-tm6utrz` quedó en estado `Stopped`, terminal según el clasificador oficial del script (`Stopped` es terminal). Lecturas finales: grupo vacío, runner ausente, lista de ejecuciones sin estados activos/desconocidos, configuración del Job sin secretos, intento/marker locales ausentes y diario LRO listo. No se repitió el ciclo. La sesión de terminal superó la ventana inicial y no conservó su línea final de salida/exit code; los estados independientes anteriores son la evidencia de registro, handshake, terminalización y cleanup.

Marketplace: se conserva el resultado de la tarea de restauración programada (`LastTaskResult=0`) y los nueve digests iguales antes/después. El coordinador reportó que el retest aún no tiene resultado; se clasifica `NOT_VERIFIED`, sin bloquear este Job diagnóstico. No se modificó ni volvió a ejecutar la tarea programada.

### Clasificación actualizada

| Elemento | Estado Fase 3B | Evidencia |
|---|---|---|
| GITHUB_ENVIRONMENT | PASS | Protecciones previas conservadas. |
| CHILE_DEPLOY_FREEZE | PASS | Gate exacto `false`, confirmado durante preflight. |
| OIDC_CONFIGURATION / OIDC_AUTH_REAL | PASS / NOT_RUN | Configuración previa intacta; ningún workflow CD despachado para autenticar. |
| CD_RBAC_PLAN / CD_RBAC_APPLIED | PASS (PR pendiente de auditoría) / NOT_RUN | Acción y prueba corregidas en Draft #272; ningún Apply. |
| SMOKE_CONFIGURATION | BLOCKED | Catalog/Inventory configuradas; tres modos/allowlists NOT_VERIFIED y sin variables nuevas. |
| QUOTA_CAPACITY | PASS (alcance de una instancia/ejecución) | Cores Consumption 2/100; Azure no expuso la cuota Job/concurrencia total. La creación y una ejecución fueron aceptadas. Saldo exacto no verificado; el coordinador autorizó consumo mínimo de un ciclo. |
| ACA_JOB_CHILE | PASS | Provisionado `Succeeded`, configuración y Resource ID verificados. |
| RUNNER_GROUP | PASS | Grupo 3 protegido y ahora vacío. |
| JIT_REGISTRATION_REAL | PASS | Runner JIT ID 57 aceptado y observado online con solo label diagnóstico. |
| ACA_JOB_EXECUTION | PASS | Una ejecución correlacionada, estado final `Stopped` terminal. |
| RUNNER_ONLINE | PASS | Estado online observado durante el ciclo; luego runner eliminado. |
| CLEANUP | PASS | Runner ausente, sin `h5jit`, sin marker/attempt, diario LRO listo, cero ejecuciones activas/desconocidas. |
| MARKETPLACE_PROTECTION | PASS | Restore previo exitoso, digests preservados, gate cerrado y sin CD; retest funcional `NOT_VERIFIED`. |
| DNS_TLS_PRIVATE / HTTP_SMOKE / CD_REAL | NOT_RUN | No se probaron ACA ni se despachó CD. |

## Fin del addendum Fase 3B

## Cierre de preparación operativa — revisión final

Actualización del 2026-11-24. Este cierre supersede estados de revisión anteriores en este documento. No se fusionó el PR, no hubo CD, HTTP ni cambios en ACA.

### PR #272 y CI del SHA auditado

El PR #272 pasó a **Ready for Review** con el HEAD autorizado `47e90bd4ac3ae640506106ec1bd0f8ab4999a302`; sigue abierto y no fusionado. Las tres CI oficiales concluyeron sobre ese mismo SHA:

| CI oficial | Run ID | Resultado | HEAD |
|---|---:|---|---|
| Integración continua (CI) | 45452018597 | SUCCESS | `47e90bd4ac3ae640506106ec1bd0f8ab4999a302` |
| Bulk PostgreSQL y RabbitMQ desechables | 45452018337 | SUCCESS | `47e90bd4ac3ae640506106ec1bd0f8ab4999a302` |
| Integración histórica Pricing y Catalog | 45452018111 | SUCCESS | `47e90bd4ac3ae640506106ec1bd0f8ab4999a302` |

No se hizo merge.

### Verificación acotada de seguridad para smoke

Con autorización del coordinador, `az containerapp secret list --show-values` se procesó en memoria, filtrando solo `G6_SECURITY_MODE` y la allowlist correspondiente. Solo se reportan los resultados permitidos; no se imprimieron ni guardaron valores de otros secretos. Las imágenes, revisiones y FQDN se leyeron de Azure; los SHA de origen y digest corresponden a la matriz de procedencia de Fase 2A.

| Servicio | Modo | Endpoint protegido candidato | En allowlist pública | SHA desplegado | FQDN efectivo | Resultado y configuración |
|---|---|---|---:|---|---|---|
| Gateway | `PUBLIC_READ_ONLY` | `GET /api/v1/promociones/administracion` | true (`listarPromocionesAdmin`) | `4c40b31b8a12335d4018861ab6d94cfd69536d7b` | `api-gateway.calmgrass-aec0b33c.chilecentral.azurecontainerapps.io` externo | Ruta pública en el modo efectivo; no se configuró como smoke protegido. |
| Pricing | `G7_AUTHENTICATED` | `GET /api/v1/precios` | false (`consultarPrecios`) | `9e4ac0af2a3ea882784413401bd5016ff611caa2` | `pricing-svc.internal.calmgrass-aec0b33c.chilecentral.azurecontainerapps.io` | Protegida y verificada. Se configuraron únicamente `AZURE_SMOKE_URL_PRICING_SVC` y `AZURE_SMOKE_PROTECTED_PRICING_SVC` en `azure-h5-chile`. |
| Promotions | `PUBLIC_READ_ONLY` | `GET /api/v1/promociones/administracion` | true (`listarPromocionesAdmin`) | `4c40b31b8a12335d4018861ab6d94cfd69536d7b` | `promotions-svc.internal.calmgrass-aec0b33c.chilecentral.azurecontainerapps.io` | Ruta pública en el modo efectivo; no se configuró como smoke protegido. |

Revisiones/digests observados: Gateway `api-gateway--mktrestore1124`, `sha256:2ec4f28ee02c222f5e407caf5ecbd2aae13a158ed3ab1b9509cc6dedb778eed3`; Pricing `pricing-svc--0000004`, `sha256:78852699924a1410382d0dd7fff83ae0ae09601aa10c8ca22f9442fd27293048`; Promotions `promotions-svc--http-4c40b31b-mwgj2k1j`, `sha256:82c272907449ab290ff7d4239b0a5805e54ed04908bd756479ed899cbd61d143`. No se ejecutó HTTP.

Catalog e Inventory conservan sus variables smoke anteriores. Inventory queda aceptada para `GET /api/v1/inventario/administracion/saldos`, documentado como `/inventario/administracion/saldos` en OpenAPI (base `/api/v1`), operation ID `listarSaldosFisicosAdministracion`, con `userBearer` y rol `GESTOR_COMERCIAL`. La mención contractual de una capacidad autorizada adicional queda como observación para una revisión de contrato posterior; no se alteró código ni OpenAPI.

### RBAC Chile y estado de autorización

Las definiciones `G6 H5 Chile Existing Container Apps Operator` y `G6 H5 Chile Container Apps Environment Reader` no existen actualmente en Azure; no se encontró una definición previa incompatible que sobrescribir. No hubo escritura. La lectura de asignaciones efectiva incluyó asignaciones de grupos e heredadas: la cuenta es una persona usuaria con rol `Contributor` a nivel de suscripción. La definición integrada de Contributor excluye `Microsoft.Authorization/*/Write`, por lo que la cuenta no puede crear definiciones de roles ni asignaciones RBAC. No se ejecutó Apply; la acción corregida del PR #272 necesita merge y aplicación posterior por un responsable facultado.

### Protección y operaciones posteriores

- `AZURE_CHILE_DEPLOY_ENABLED=false` continúa confirmado.
- Se conserva el Job `azure-h5-smoke-chile`, el diario LRO y la evidencia de limpieza del único JIT aceptado en Fase 3B. No se repitió el diagnóstico.
- El resultado funcional del retest Marketplace sigue `NOT_VERIFIED`; no bloquea este cierre. La restauración y la igualdad de los nueve digests permanecen documentadas en las secciones anteriores.
- No se modificaron `azure-h5`, `azure-h5-pilot-234`, las ACA existentes, Supabase, Service Bus ni Marketplace. No se ejecutó CD, despliegue, publicación, JIT adicional o HTTP.

## Fin del cierre de preparación operativa

## Addendum Fase 4/5 — actualización 2026-11-24

El trabajo siguiente continúa en rama aislada `trabajo/castilla/h5-fixtures-integracion-g5`, base Backend `49bab9e2075819d922c63b06fcc6fc6ac16ce703`. El PR #272 permanece cerrado según verificación previa; no se repitió su trabajo. El RBAC Chile continúa aplicado/verificado según el handoff Fase 4. Este addendum no autoriza operaciones sobre Supabase compartido ni ACA.

Estado vigente del freeze: `AZURE_CHILE_DEPLOY_ENABLED=false` según lectura previa; no se cambió la variable. No hubo despliegue, CD, HTTP, cambio de escala/tráfico/ingress, Service Bus ni Marketplace. El resultado funcional del retest Marketplace sigue `NOT_VERIFIED`.

Para el release H5, Gateway smoke y las configuraciones anteriores válidas permanecen sin cambios. Promotions continúa sin variable protegida: el endpoint administrativo disponible en la imagen auditada estaba expuesto como lectura pública por `PUBLIC_READ_ONLY` y allowlist; no es válido como smoke de rechazo de autenticación. No se alteró configuración ACA ni se envió HTTP. Consulte la matriz de release actual en `HANDOFF-G6-H5-F-FASE-5.md`.

Los fixtures aislados ahora cuentan con candidato de lifecycle que consulta `catalog.sku_identity`, maneja SKU base y variantes, versión/estado Catalog y reporta rechazo sin escrituras; usa únicamente PostgreSQL local descartable y no cambió Supabase. Las validaciones locales y el bloqueo actual Docker se detallan en handoffs Fases 4 y 5. Estos estados no alteran la evidencia operativa/CI de la preparación Azure anterior.

## Resultado ejecutivo

Se creó el Environment GitHub Chile protegido y cerrado, la identidad UAMI dedicada y su única federación OIDC aprobada. Se configuraron variables Azure del Environment y smoke parcial para Catalog/Inventory. El plan RBAC se generó en seco. No se aplicó RBAC, no se probó autenticación OIDC, no se creó el Job y no se ejecutó JIT.

La creación del ACA Job quedó bloqueada: aunque el Environment existente tiene Consumption y Azure informa ese perfil disponible en Chile Central, no se pudo comprobar crédito/presupuesto ni una cuota ACA de ejecución Job. La API de usos no publica esa cuota; no hay budget configurado y el CLI disponible no expone balances. La regla de esta fase exige detener el aprovisionamiento del Job ante esa falta de evidencia.

La tarea Windows preexistente `G6-Marketplace-Azure-Restore-20261124` se inició a las 12:00 Lima y terminó con `LastTaskResult=0`. No se modificó, canceló ni ejecutó manualmente. La lectura Azure posterior muestra la restauración esperada de escala de Gateway y Pricing y el baseline completo queda registrado más abajo. El retest Marketplace aún carece de evidencia de resultado en los artefactos consultados.

## Recursos y configuración

### GitHub Environment `azure-h5-chile`

- Creado y protegido con `can_admins_bypass=false`, reviewers requeridos y `prevent_self_review=true`.
- Reviewer: `lightbluedev05`, distinto del actor autenticado `mrcastilla8`; verificados permiso `Admin` directo al repositorio y pertenencia al equipo `retail-operator`.
- Política personalizada: solo rama `master` (exactamente una branch policy).
- `AZURE_CHILE_DEPLOY_ENABLED=false`, presente en este Environment. Se comprobaron listados de variables de organización y repositorio sin homónimos. `azure-h5` y `azure-h5-pilot-234` no fueron modificados.
- Cero runs CD oficiales activos/listados y cero deployments de `azure-h5-chile` al momento de la comprobación.

### Identidad y OIDC

- Identidad dedicada creada: `g6-h5-chile-github-cd`.
- Resource ID: `/subscriptions/fef42188-accd-4470-ae88-78f583eb4906/resourceGroups/rg-g6-aca-chile/providers/Microsoft.ManagedIdentity/userAssignedIdentities/g6-h5-chile-github-cd`.
- Client ID: `3c6cb24d-0922-425e-9057-987e468ea179`.
- Principal ID: `ebee1e6c-f8ee-4ba0-bf6e-fe593ee7e7ca`.
- Tenant ID: `328b34df-5728-48fb-8ed3-6fc2d93c94a6`.
- Federated credential `github-actions-azure-h5-chile`: issuer `https://token.actions.githubusercontent.com`, audience `api://AzureADTokenExchange`, subject `repo:Taller-SW-Web/G6-Productos-Ofertas-backend:environment:azure-h5-chile`.
- Environment variables `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` coinciden con la UAMI, tenant y suscripción. No hay homónimos en organización/repositorio.
- No se despachó workflow y no hubo autenticación OIDC real. La identidad no tiene asignaciones RBAC.

### RBAC

Ejecutados dos planes de solo lectura con `prepare-cd-rbac.ps1 -Destination chile-shared`; el segundo resolvió la UAMI y enumeró los cinco scopes: Catalog, Inventory, Pricing, Promotions y Gateway. No se crearon definiciones ni asignaciones.

El operador autenticado es `Contributor` en scope de suscripción. No tiene rol acreditado para administrar RBAC; no se ejecutó `-Apply`.

Los templates Chile proponen lectura del RG/Environment y `containerApps/read,write` con delete denegado en cada ACA. La identidad no tiene asignaciones heredadas ni directas. Los roles personalizados aún no existen en Azure. Hay un bloqueo técnico antes de poder aplicar: el provider anuncia `Microsoft.App/containerApps/revisions/read` como acción separada, pero el template actual no la incluye. `deploy.sh` invoca `az containerapp revision show`; el rol actual planificado no demuestra permiso para esa lectura. Responsable RBAC debe resolver e incorporar explícitamente la acción mínima en el procedimiento/rol, y autorizar la aplicación. No se amplió el scope ni se eligió `Contributor`/`Owner` como solución.

### ACA compartidas y baseline Marketplace

Metadata consultada en `rg-g6-aca-chile`, suscripción `fef42188-accd-4470-ae88-78f583eb4906`, Environment `env-g6-phase1-chile`, Chile Central. Los nueve recursos están en ese Environment. Las revisiones servidas estaban activas, `Healthy` y con 100% de tráfico. Gateway tiene revisión explícita `api-gateway--mkt1124`; los otros ocho usan `latestRevision` al 100%.

| Servicio | Resource ID (sufijo ACA) | Revisión servida (100%) | Imagen de aplicación / digest | Escala min–max | Ingress / FQDN |
|---|---|---|---|---|---|
| Gateway | `.../containerapps/api-gateway` | `api-gateway--mkt1124` | `api-gateway@sha256:2ec4f28ee02c222f5e407caf5ecbd2aae13a158ed3ab1b9509cc6dedb778eed3` | 1–1 | Externo; `api-gateway.calmgrass-aec0b33c.chilecentral.azurecontainerapps.io` |
| Catalog | `.../containerapps/catalog-svc` | `catalog-svc--b80jpbt` | `catalog-svc@sha256:7bdb66c1bb94de9861f2c930eb6d7c899730b60fac3457785e1ac71ed766079e` | 1–1 | Interno; `catalog-svc.internal.calmgrass-aec0b33c.chilecentral.azurecontainerapps.io` |
| Inventory | `.../containerapps/inventory-svc` | `inventory-svc--http-4c40b31b-mwgil3mw` | `inventory-svc@sha256:d41a9d0a3b91f8619731c7099af6dd4521ddbf97fa088baa9039b09b03143ab6` | 1–1 | Interno; `inventory-svc.internal.calmgrass-aec0b33c.chilecentral.azurecontainerapps.io` |
| Pricing | `.../containerapps/pricing-svc` | `pricing-svc--0000003` | `pricing-svc@sha256:78852699924a1410382d0dd7fff83ae0ae09601aa10c8ca22f9442fd27293048` | 1–1 | Interno; `pricing-svc.internal.calmgrass-aec0b33c.chilecentral.azurecontainerapps.io` |
| Promotions | `.../containerapps/promotions-svc` | `promotions-svc--http-4c40b31b-mwgj2k1j` | `promotions-svc@sha256:82c272907449ab290ff7d4239b0a5805e54ed04908bd756479ed899cbd61d143` | 0–1 | Interno; `promotions-svc.internal.calmgrass-aec0b33c.chilecentral.azurecontainerapps.io` |
| Bulk | `.../containerapps/bulk-svc` | `bulk-svc--http-4c40b31b-mwgil3mw` | `bulk-svc@sha256:19ecb55d61c55c7fdaffd2663a1302c5c708359d30b243e1284573ab9b5dcc03` | 1–1 | Interno; `bulk-svc.internal.calmgrass-aec0b33c.chilecentral.azurecontainerapps.io` |
| Combos | `.../containerapps/combos-svc` | `combos-svc--http-4c40b31b-mwgil3mw` | `combos-svc@sha256:b032f5ab652a820b131e60c15b89d0081431ef2e540727e43853c6aa39436c9f` | 1–1 | Interno; `combos-svc.internal.calmgrass-aec0b33c.chilecentral.azurecontainerapps.io` |
| Taxonomy | `.../containerapps/taxonomy-svc` | `taxonomy-svc--http-4c40b31b-mwgii22g` | `taxonomy-svc@sha256:9226c8098b2be7afe9ab751950526a72df6bb2d720389ea6b626e822027eb4be` | 1–1 | Interno; `taxonomy-svc.internal.calmgrass-aec0b33c.chilecentral.azurecontainerapps.io` |
| Price Audit | `.../containerapps/price-audit-svc` | `price-audit-svc--http-4c40b31b-mwgil3mw` | `price-audit-svc@sha256:c0f4170eaf3063a1dfe9a72c4dad2b20c3f0d6a52f2254ca56a84243e5d745a9` | 1–1 | Interno; `price-audit-svc.internal.calmgrass-aec0b33c.chilecentral.azurecontainerapps.io` |

Gateway conserva además el sidecar Caddy `caddy:2.11.6-alpine@sha256:d44355d3c2149dc580ce2cac735955d1c08d3d00882c30489c241aa51a5c10d9`. No se cambiaron imagen, revisión, escala, tráfico, configuración o ingress de ninguna ACA por esta fase.

La lectura inicial y la verificación repetida antes de la tarea coincidían en las nueve ACA. La lectura final se hizo después de que Task Scheduler reportara éxito. Solo cambiaron las revisiones/escala de Gateway y Pricing, coherentes con la restauración planificada; los nueve digests de aplicación y el digest Caddy permanecen iguales y cada revisión servida conserva 100% del tráfico y `Healthy`. El agente no modificó ninguna ACA.

### Rutas y smoke

Contraste estático con Docs master `40524e96c6973f84d74160076781702fe2a3da19` y con el código de las revisiones fuente acreditadas en el handoff de Fase 2A:

- Catalog `/api/v1/productos/administracion`: existe; `CatalogAuthGuard` y `RequireCatalogIdentity` exigen identidad user/rol `GESTOR_COMERCIAL`. Docs OpenAPI declara `userBearer`.
- Inventory `/api/v1/inventario/administracion/saldos`: existe; `UserAuthGuard` y pruebas del servicio rechazan solicitud sin autenticación. Docs incluye la ruta pero omite `security`; discrepancia contractual reportada, sin cambiar código/Docs.
- Pricing `/api/v1/precios`: existe; `PricingReadGuard`, Docs OpenAPI `userBearer`. El código permite excepción de lectura anónima solo en `PUBLIC_READ_ONLY` y con `consultarPrecios` explícitamente habilitada.
- Promotions `/api/v1/promociones/administracion`: existe; `PromotionsQueryGuard`, Docs OpenAPI `userBearer`. El código incluye una excepción de lectura anónima opt-in para `listarPromocionesAdmin` bajo `PUBLIC_READ_ONLY`.
- Gateway usa FQDN externo existente y route table `userBearer`; el código contempla una excepción opt-in análoga en `PUBLIC_READ_ONLY` para `listarPromocionesAdmin`.

Los valores efectivos `G6_SECURITY_MODE` y listas de operaciones públicas de Gateway/Pricing/Promotions están referenciados como secretos en ACA. No se leyeron valores secretos. Por eso no se puede demostrar que esas tres rutas rechacen anonymous requests: se dejaron sin variables smoke hasta que el owner confirme la configuración de forma saneada. Para Catalog e Inventory se configuraron solo en `azure-h5-chile` los FQDN HTTPS y las rutas protegidas exactas; no se enviaron solicitudes HTTP.

No se habilitó ingress externo en microservicios.

### Job JIT y capacidad

- El Environment Chile está provisionado, Consumption y sin VNet; `publicNetworkAccess=Enabled`, `vnetConfiguration=null`, sin configuración adicional de Log Analytics. La API `Microsoft.App/locations/.../availableManagedEnvironmentsWorkloadProfileTypes` informa Consumption disponible (4 vCPU / 8 GiB); el Environment ya reporta el perfil Consumption.
- `locations/usages` reporta Environment count 1/1 y no expone una cuota de ejecución de ACA Job. El presupuesto de suscripción consultado no tiene entradas. `az consumption balances` no está disponible en la instalación actual; no se instaló extensión Azure CLI ni se modificó su configuración. El crédito/presupuesto restante no quedó verificado.
- El operador tiene Contributor a nivel suscripción, suficiente para job write según rol, no para administrar roles. No se creó el Job Chile por falta de evidencia de capacidad/presupuesto exigida por la fase.
- Job Chile no existe. No se creó recurso de red adicional.
- Job Brasil se consultó solo como referencia: Manual, Consumption, 0.5 CPU/1 GiB, un contenedor, `run.sh --jitconfig`, sin identidad administrada y sin secreto persistente; usa el digest runner especificado `sha256:4037925f16bd0626196684aff1853dabd242675c82efe08f0a2d376694738d19`. `docker manifest inspect` verificó disponibilidad de ese manifiesto en GHCR sin pull ni ejecución.

### Runner group y preflight JIT

- Grupo existente `g6-h5-private-smoke`, ID 3: allowlist contiene exclusivamente `Taller-SW-Web/G6-Productos-Ofertas-backend`; restringido a `.github/workflows/cd-services-azure.yml@refs/heads/master`; cero runners. `verify-runner-group.ps1 -Destination chile-shared` pasó. El flag `allows_public_repositories` está en true, pero no hay otro repositorio seleccionado; no se cambió el grupo.
- Cero runs CD y deployments del Environment Chile en la comprobación.
- `CLEANUP_INCOMPLETE.json` y `JIT_ATTEMPT.json` ausentes; diario LRO compartido pasó `Assert-AcaPatchJournalReady`. No se borró/alteró el diario ni marcadores.
- El operador Marketplace confirmó que un diagnóstico JIT no interferiría, pero no se cumplieron las demás condiciones: Job Chile no existe y su aprovisionamiento está bloqueado por cuota/presupuesto. No se ejecutó JIT, ACA Job execution ni registro de runner.

## Estado de aceptación

| Elemento | Estado | Evidencia / bloqueo |
|---|---|---|
| GITHUB_ENVIRONMENT | PASS | Protecciones y branch policy comprobadas. |
| CHILE_DEPLOY_FREEZE | PASS | Solo Environment Chile contiene `AZURE_CHILE_DEPLOY_ENABLED=false`; no hay CD activo. |
| OIDC_CONFIGURATION | PASS | UAMI, federación y variables de Environment coinciden. |
| OIDC_AUTH_REAL | NOT_RUN | No se despachó workflow. |
| CD_RBAC_PLAN | BLOCKED | Dry run ejecutado; role template omite `Microsoft.App/containerApps/revisions/read`. |
| CD_RBAC_APPLIED | NOT_RUN | Requiere owner facultado y corrección/aprobación del permiso mínimo. |
| SMOKE_CONFIGURATION | BLOCKED | Catalog/Inventory configurados; Gateway/Pricing/Promotions pendientes de validar flags secretos de modo público. |
| QUOTA_CAPACITY | BLOCKED | Consumption disponible, pero sin cuota/budget/crédito verificables para Job. |
| ACA_JOB_CHILE | BLOCKED | No creado hasta verificar capacidad/budget. |
| RUNNER_GROUP | PASS | Script oficial pasó; repo/workflow únicos y grupo vacío. |
| JIT_REGISTRATION_REAL | BLOCKED | Job inexistente; no se ejecutó. |
| ACA_JOB_EXECUTION | NOT_RUN | Sin Job Chile. |
| RUNNER_ONLINE | NOT_RUN | No se registró runner. |
| CLEANUP | NOT_RUN | No hubo ciclo JIT; marcador/attempt ausentes y diario listo. |
| MARKETPLACE_PROTECTION | PASS | Freeze cerrado, no CD; tarea preexistente terminó con código 0 y la metadata refleja la escala restaurada. Retest sin evidencia de resultado nuevo. |
| DNS_TLS_PRIVATE | NOT_RUN | Sin Job Chile y no se probaron endpoints. |
| HTTP_SMOKE | NOT_RUN | No hubo solicitudes HTTP. |
| CD_REAL | NOT_RUN | No se despachó CD. |

## Bloqueos y autorizaciones pendientes

1. **Azure Marketplace/operador**: permitir que finalice la tarea ya iniciada; owner debe aportar resultado de la restauración y confirmar retest (la hora 12:00 no habilita CD). Después, comparar baseline final contra este baseline pre-tarea.
2. **Owner de identidad/RBAC**: corregir/revisar la acción mínima `Microsoft.App/containerApps/revisions/read`; verificar rol personalizado/scopes y aplicar solo con aprobación explícita usando el procedimiento oficial. Operador actual es Contributor, no administrador RBAC.
3. **Owner de suscripción/costos**: entregar evidencia de crédito/presupuesto y cuota/capacidad suficiente para una ejecución Job efímera. Hasta entonces no crear Job ni iniciar JIT.
4. **Owner de runtime/seguridad**: confirmar sin divulgar valores si Gateway/Pricing/Promotions están en `G7_AUTHENTICATED` y sin esos operation IDs públicos. Si no, declarar incompatibilidad de smoke antes de configurar esas variables.
5. **Owner del contrato/docs**: corregir/verificar la declaración de seguridad `userBearer` omitida en Inventory OpenAPI si corresponde; no se alteró el contrato.

## Operaciones de esta fase

- Solo se crearon: GitHub Environment protegido `azure-h5-chile`, UAMI `g6-h5-chile-github-cd` y su credencial federada exacta.
- Se configuraron variables GitHub exclusivamente en `azure-h5-chile`; gate en `false`.
- Solo se planificó RBAC; ninguna definición/asignación aplicada.
- Se consultó metadata Azure, GitHub, el Job de referencia y manifiesto GHCR. No se cambió el contexto global de Azure CLI; comandos Azure usaron la suscripción explícita.
- No se crearon ACA Jobs, ACA apps, redes, Environments adicionales, runner groups, credenciales persistentes ni Service Bus roles.
- El agente no cambió ninguna ACA, imagen, revisión, escala, tráfico o ingress. La tarea Marketplace preexistente sí produjo tras su hora programada nuevas revisiones de Gateway y Pricing para restaurar escala 0–1; la imagen de ambas aplicaciones y el tráfico 100% se conservaron. No se ejecutaron CD, JIT, Apply, HTTP, migraciones, pruebas comerciales, cambios de Supabase, Service Bus o datos Marketplace.

## Handoffs vinculados

- Handoff de imágenes/procedencia de Fase 2A: [HANDOFF-G6-H5-F-FASE-2A.md](HANDOFF-G6-H5-F-FASE-2A.md).

### Baseline final posterior a la restauración programada (24/11/2026, ~12:05 Lima)

Task Scheduler: `LastRunTime=12:00`, `LastTaskResult=0`, sin próxima ejecución. Metadata Azure posterior:

| Servicio | Revisión servida | Digest app (igual al inicio) | Tráfico | Escala min–max | Estado |
|---|---|---|---|---|---|
| Gateway | `api-gateway--mktrestore1124` | `sha256:2ec4f28ee02c222f5e407caf5ecbd2aae13a158ed3ab1b9509cc6dedb778eed3` | 100% revisión explícita | 0–1 | Healthy |
| Catalog | `catalog-svc--b80jpbt` | `sha256:7bdb66c1bb94de9861f2c930eb6d7c899730b60fac3457785e1ac71ed766079e` | 100% latest | 1–1 | Healthy |
| Inventory | `inventory-svc--http-4c40b31b-mwgil3mw` | `sha256:d41a9d0a3b91f8619731c7099af6dd4521ddbf97fa088baa9039b09b03143ab6` | 100% latest | 1–1 | Healthy |
| Pricing | `pricing-svc--0000004` | `sha256:78852699924a1410382d0dd7fff83ae0ae09601aa10c8ca22f9442fd27293048` | 100% latest | 0–1 | Healthy |
| Promotions | `promotions-svc--http-4c40b31b-mwgj2k1j` | `sha256:82c272907449ab290ff7d4239b0a5805e54ed04908bd756479ed899cbd61d143` | 100% latest | 0–1 | Healthy |
| Bulk | `bulk-svc--http-4c40b31b-mwgil3mw` | `sha256:19ecb55d61c55c7fdaffd2663a1302c5c708359d30b243e1284573ab9b5dcc03` | 100% latest | 1–1 | Healthy |
| Combos | `combos-svc--http-4c40b31b-mwgil3mw` | `sha256:b032f5ab652a820b131e60c15b89d0081431ef2e540727e43853c6aa39436c9f` | 100% latest | 1–1 | Healthy |
| Taxonomy | `taxonomy-svc--http-4c40b31b-mwgii22g` | `sha256:9226c8098b2be7afe9ab751950526a72df6bb2d720389ea6b626e822027eb4be` | 100% latest | 1–1 | Healthy |
| Price Audit | `price-audit-svc--http-4c40b31b-mwgil3mw` | `sha256:c0f4170eaf3063a1dfe9a72c4dad2b20c3f0d6a52f2254ca56a84243e5d745a9` | 100% latest | 1–1 | Healthy |

Gateway Caddy remains `caddy:2.11.6-alpine@sha256:d44355d3c2149dc580ce2cac735955d1c08d3d00882c30489c241aa51a5c10d9`. Revisions of Gateway and Pricing changed after the scheduled restore while the exact app digest remained; traffic stayed at 100%. No new retest outcome was present in the handoff/evidence read during this phase.

## Addendum — cierre RBAC y preparación Fase 4 (2026-11-24)

### Estado definitivo PR #272 / CI

- PR #272 fue actualizado desde `origin/master` con merge normal, sin reescritura. HEAD revisado: `1132da9d97da1ff2cebd8a38bb103769a8de5da9`. Diff respecto de master: exclusivamente el JSON del rol Chile y su prueba, con la acción aprobada `Microsoft.App/containerApps/revisions/read`.
- CI PR sobre HEAD exacto: CI `45462405261` SUCCESS; Bulk `45462405224` SUCCESS; Pricing/Catalog `45462405214` SUCCESS.
- Merge autorizado ejecutado sin `--admin`: merge commit `238d809218cae8dbe837ef615d45a91cbec251e1`. El HEAD del PR es ancestro de `origin/master`, actualmente en ese merge commit.
- CI push master: `45463712189` SUCCESS y Bulk `45463711913` SUCCESS. Pricing/Catalog no se disparó para ese push porque el merge solo modificó RBAC.

### Permisos activos y RBAC Chile

- Cuenta Azure `marecahu02@hotmail.com`, suscripción Azure for Students `fef42188-accd-4470-ae88-78f583eb4906`, tenant `328b34df-5728-48fb-8ed3-6fc2d93c94a6`. La auditoría `Microsoft.Authorization/permissions` mostró Owner efectivo, con `roleDefinitions/write` y `roleAssignments/write` permitidos, en suscripción/RG/ACA objetivo. No se modificó el acceso del usuario.
- Plan `prepare-cd-rbac.ps1 -Destination chile-shared` confirmó RG `rg-g6-aca-chile`, Environment `env-g6-phase1-chile`, UAMI `g6-h5-chile-github-cd`, y cinco ACA exactas.
- Aplicación completada bajo la autorización del coordinador: se crearon únicamente dos roles personalizados Chile. `Existing Container Apps Operator` ID `b200d8ca-ee9d-45a1-8507-bf714e46079d`; acciones exactas `containerApps/read`, `containerApps/write`, `containerApps/revisions/read`; NotActions solo `containerApps/delete`; AssignableScope solo RG Chile. `Container Apps Environment Reader` ID `aa5dbece-7907-4ac0-8006-e464545b1272`; acciones exactas `managedEnvironments/read`, `resourceGroups/read`; sin acciones adicionales; AssignableScope solo RG Chile.
- Se verificó una asignación de lector a nivel RG y cinco asignaciones operador, una por `api-gateway`, `catalog-svc`, `inventory-svc`, `pricing-svc`, `promotions-svc`, Principal ID UAMI `ebee1e6c-f8ee-4ba0-bf6e-fe593ee7e7ca`. No hubo Owner/Contributor ni scopes amplios para la UAMI.
- El script de Apply informó error en la creación de la cuarta asignación después de crear el lector y tres scopes; no se repitió el Apply. Se completaron solo los dos scopes faltantes mediante Azure CLI con el Role Definition ID aprobado y se verificó la lista final exacta de seis asignaciones. No se alteraron roles Brasil.
- La federación mantiene una sola credencial con issuer/audience/subject de `azure-h5-chile`; Environment conserva reviewer requerido, no autoaprobación, sin bypass y solo master. No existe verificador de autenticación OIDC sin ejecutar CD; `OIDC_AUTH_REAL=NOT_RUN`.

### Smoke

| Servicio | Endpoint protegido acreditado | Configuración Environment |
|---|---|---|
| Catalog | `/api/v1/productos/administracion` | Configurada previamente; URL interna existente |
| Inventory | `/api/v1/inventario/administracion/saldos` | Configurada previamente; UserAuthGuard y contrato aceptado |
| Pricing | `/api/v1/precios` | Configurada previamente |
| Gateway | `/api/v1/productos/administracion` | Configurada en esta intervención, tras comprobar operación del contrato, `userBearer`, rol `GESTOR_COMERCIAL` y ausencia en allowlist pública, para FQDN Gateway efectivo |
| Promotions | No se encontró otra ruta GET administrativa protegida en el SHA desplegado; rutas GET disponibles estaban en `PUBLIC_READ_ONLY` allowlist | Sin variable, pendiente de release H5 |

No se ejecutó HTTP. Gate de despliegue Chile permanece exactamente `false`. La observación sobre capacidad adicional de Inventory en contrato se conserva para revisión contractual posterior; no se cambió endpoint ni OpenAPI.

### Fase 4 — auditoría Supabase y fixtures

La auditoría se hizo en modo de solo lectura sobre Supabase `slzglmtiyrzygpkiuthf`, `ACTIVE_HEALTHY`, región `sa-east-1`, PostgreSQL 17.11. Sin DML, migraciones, cambios de schema ni fixtures. Evidencia previa y matrices se amplían en `HANDOFF-G6-H5-F-FASE-4.md`; scripts de preflight/verify/cleanup preview bajo `ops/supabase/g5-fixtures/`.

Hallazgos de preparación relevantes: tablas de negocio sin RLS general, por lo que prefijo QA no aísla; ledger de migraciones no concuerda totalmente con objetos H5 físicos; la restricción de `promotions.coupon_uses.channel_id` no admite `VENTAS` aunque el contrato HTTP la enumera; `po_promotions_runtime` no tiene permisos DML/select sobre tablas H5 mientras el rol dev sí. No se deben aplicar migraciones ni crear datos hasta reconciliar DDL/checksums/roles en un branch descartable.

No se creó un branch Supabase ni se escribieron scripts DML especulativos. La ruta de preparación exige branch Supabase independiente y owner SQL revisado para inicializar stock sintético, dado que no se identificó endpoint autorizado de ajuste de stock y el ciclo de evento Service Bus está fuera de alcance. Los scripts agregados son explícitamente de solo lectura.

### Estado de cierre

`ADMIN_PERMISSIONS=PASS`; `PR_272_MERGED=PASS`; `CD_RBAC_PLAN=PASS`; `CD_RBAC_APPLIED=PASS` (aplicación exacta completada, con nota del fallo parcial de CLI explicado arriba); `CD_RBAC_VERIFIED=PASS`; `OIDC_CONFIGURATION=PASS`; `OIDC_AUTH_REAL=NOT_RUN`; `RUNNER_JIT_READY=PASS` por evidencia aceptada runner 57/ejecución `azure-h5-smoke-chile-tm6utrz`, sin repetir; `SMOKE_CONFIGURATION=PARTIAL` (4 de 5); `CHILE_DEPLOY_FREEZE=PASS`; `SUPABASE_AUDIT=PARTIAL` por reconciliación de ledger/contrato/rol pendiente; `FIXTURES_PREPARED=PARTIAL`; `FIXTURES_APPLIED=NOT_RUN`; `CD_REAL=NOT_RUN`. El retest funcional Marketplace continúa `NOT_VERIFIED`. No se cambiaron ACA, Supabase, Service Bus o recursos Marketplace.
