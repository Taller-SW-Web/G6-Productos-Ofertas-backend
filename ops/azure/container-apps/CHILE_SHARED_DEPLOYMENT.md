# CD H5 sobre el runtime compartido de Chile

## Alcance

`chile-shared` reutiliza `rg-g6-aca-chile` y `env-g6-phase1-chile`. El CD actualiza la imagen del contenedor de aplicación existente por digest. En Gateway y Price Audit gestiona además la ruta de tráfico propia del corte controlado. Se conservan Caddy, identidad, secretos, escala, probes y restricciones de ingress.

Las nueve aplicaciones se pueden seleccionar individualmente. `all` se rechaza para Chile. El plan RBAC inicial usa Catalog, Inventory, Pricing, Promotions y Gateway; los otros cuatro requieren selección expresa y autorización del owner RBAC.

## Gateway: perfil aislado G5 durante uso de Marketplace

El workflow manual admite `gateway_route_profile=g5-labelled` únicamente con `destination=chile-shared` y `service=api-gateway`. El perfil estándar continúa igual para Gateway y para todos los demás servicios.

El perfil G5 publica la imagen oficial inmutable por digest y fija `GATEWAY_G5_H5_ENABLED=true` solo en la nueva revisión de Gateway. Exige modo ACA `Multiple`, revisión Marketplace previa sana y una única ruta default fijada al 100 % a una revisión explícita. Tras crear la revisión, asigna la etiqueta ACA `g5-h5` y comprueba por separado que:

- el FQDN default de Gateway conserva la revisión Marketplace anterior al 100 %;
- `https://api-gateway---g5-h5.<environment-domain>` enruta directamente a la revisión G5 nueva;
- la imagen/digest, revisión, flag de esa revisión y etiqueta coinciden;
- el recibo incluye el run, Environment, resource ID, SHA/digest, revisión Marketplace, ruta etiquetada y URL usada por el smoke.

ACA revision labels funcionan independientemente del split de tráfico del FQDN default. La etiqueta G5 debe recibir el smoke de este mismo run desde el runner autorizado; no se asigna porcentaje de tráfico default a la revisión G5. El smoke anónimo comprueba liveness y rechazo de la ruta protegida; no sustituye la prueba con JWT real de G7 ni acredita por sí solo la certificación de despliegue. Un run CD fallido nunca es certificación `SUCCESS`, aunque la etiqueta/digest sigan observables.

La recuperación supervisada solo retira `g5-h5` y el flag H5 si el recibo identifica exactamente la revisión Marketplace, el digest, la etiqueta y la configuración esperada. Si hay drift de tráfico, revisión o digest, se bloquea sin sobrescribirlo. No se cambia `G6_SECURITY_MODE`, Caddy ni la ruta default de Marketplace.

Este perfil no abre la ventana ni aprueba un despliegue. Sigue requiriendo el Environment `azure-h5-chile`, su aprobación humana, `AZURE_CHILE_DEPLOY_ENABLED=true` y un SHA vigente de `master` con CI aprobada.

## Verificación de Gateway bajo Modalidad B

Para el release general usa el perfil estándar y conserva la revisión y la URL de la etiqueta G5. El smoke del CD valida el recibo con la revisión y el digest servidos, liveness desde el runner privado, rechazo anónimo en APIM con correlación y rechazo directo con HTTP 403.

Después de desplegar el Gateway, abre el Frontend con la sesión existente de G7 con rol `GESTOR_COMERCIAL`. En la pantalla de administración de productos, identifica la petición de solo lectura `GET /api/v1/productos/administracion` vía APIM y confirma el HTTP 200 y su `X-Correlation-Id`. Guarda solo la operación, el estado, el identificador de correlación y la hora UTC. Busca ese mismo identificador en el registro JSON `gateway_request` del contenedor de Gateway, filtrado a la revisión del recibo del mismo run. Comprueba operación `listarProductosAdministracion`, código HTTP 200, el campo `owner=catalog-svc` y `upstreamReached=true`. Captura la revisión y el digest servidos antes y después de la solicitud. Si falta la sesión o la traza correlacionada, registra el nivel de evidencia alcanzado y el caso L2 pendiente. Omite cuerpos de negocio y credenciales del paquete de evidencia.

## Corte de Price Audit y consumidor R16

Price Audit conserva el modo `Multiple` y su escala. Antes de la oleada, el propietario de RBAC debe acreditar que la identidad OIDC de `azure-h5-chile` tiene `Microsoft.App/containerApps/revisions/activate/action` y `Microsoft.App/containerApps/revisions/deactivate/action` sobre el recurso de `price-audit-svc`. Esta comprobación incluye las dos acciones de recuperación. Las acciones de lectura de revisiones y escritura de la aplicación por sí solas no conceden esos permisos.

El preflight del ejecutor exige que la revisión que sirve el 100 % del tráfico sea la única revisión activa de Price Audit configurada con Service Bus. La revisión nueva puede consumir R16 mientras calienta, aun con peso HTTP cero. Durante este intervalo las entregas se protegen con PeekLock e Inbox. Después de confirmar salud, digest y corte HTTP explícito, el CD desactiva la revisión anterior, comprueba cero réplicas y verifica que queda una única revisión activa configurada para consumir R16. El recibo registra su identidad. La certificación del consumo efectivo se hace con un mensaje sintético y la correlación de la entrega persistida.

Ante un fallo de corte o smoke, la recuperación oficial verifica el hash estricto y el estado de tráfico del recibo. Reactiva la revisión anterior si corresponde, espera que esté sana, vuelve a fijarle el tráfico y retira al candidato del consumo, incluso si permanecía al 0 %. Al restaurar el digest de la plantilla se puede crear otra revisión. El ejecutor también la desactiva y confirma la única revisión consumidora antes de declarar éxito. Cambios manuales de flags y consumidores inesperados requieren conciliación supervisada antes de continuar. Las revisiones históricas que no consumen R16 se conservan.

## Ventana de despliegue

Un owner autorizado administra manualmente la variable `AZURE_CHILE_DEPLOY_ENABLED` del GitHub Environment `azure-h5-chile`. El workflow la consume desde `vars` dentro del job `deploy`, después de la aprobación humana del Environment y antes de solicitar OIDC. `deploy.sh` vuelve a rechazar el despliegue Chile si el valor no es exactamente `true`; inspect y recuperación supervisada no están sujetos a esta variable.

1. Antes de abrir la ventana, confirmar Marketplace protegido y la regla de revisión humana de `azure-h5-chile`. Los únicos revisores son `mrcastilla8` y `AXL031`. Cualquiera puede aprobar un job pendiente. La política acordada conserva `prevent_self_review=false` y requiere una aprobación humana registrada, incluso cuando el aprobador disparó el run. El bypass administrativo está deshabilitado y solo se admite la rama `master`.
2. Verificar con permisos de lectura que el nombre `AZURE_CHILE_DEPLOY_ENABLED` no exista en variables de repositorio ni de organización; debe existir exclusivamente en el Environment `azure-h5-chile`. No puede haber homónimos en scopes superiores que actúen como fallback del contexto `vars`.
3. Para abrir la ventana, establecer `AZURE_CHILE_DEPLOY_ENABLED` con valor exacto `true` en `azure-h5-chile`. La aprobación humana del Environment sigue siendo obligatoria. Preparación, auditoría de dependencias y publicación de imágenes pueden avanzar con la ventana cerrada porque no modifican las ACA.
4. Ejecutar el workflow manual existente `CD Azure Container Apps H5`, elegir `chile-shared`, seleccionar un servicio individual y proporcionar el SHA completo vigente de `master` con CI exitosa.
5. Para cerrar la ventana, quitar la variable o asignarle un valor distinto de `true`; esto bloquea nuevos despliegues antes de OIDC, pero no cancela ni invalida retroactivamente un job activo. Antes de comenzar Marketplace protegido, cerrar la ventana y comprobar en Actions que no existan ejecuciones CD activas o pendientes que puedan continuar.
6. Durante ventanas protegidas de Marketplace, mantener el piloto histórico #234 fuera del carril. La recuperación parte del mismo run, sus recibos completos y una aprobación humana de `mrcastilla8` o `AXL031` en el Environment. El cierre de la ventana impide nuevos despliegues y conserva el proceso supervisado de recuperación.

No ejecutar la activación durante Marketplace protegido. Esta fase no crea ni modifica el Environment ni la variable.

## OIDC y credenciales futuras

El Environment futuro es `azure-h5-chile`; sus variables de Environment serán `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` y `AZURE_SUBSCRIPTION_ID`. La suscripción esperada es `fef42188-accd-4470-ae88-78f583eb4906`.

La identidad dedicada se denominará `g6-h5-chile-github-cd`, separada de identidades runtime y de Brasil. La federación deberá limitarse a la audiencia `api://AzureADTokenExchange` y al subject del Environment protegido `repo:Taller-SW-Web/G6-Productos-Ofertas-backend:environment:azure-h5-chile`. El issuer es `https://token.actions.githubusercontent.com`. No se deben crear credenciales ni asignaciones hasta la autorización operativa del responsable de identidad/RBAC.

La asignación de lectura del RG/Environment es de lectura. La operación de actualización se asigna en los resource IDs ACA elegidos, individualmente; no se asigna `Owner`, `Contributor` ni escritura ACA en scope del RG. La acción `Microsoft.App/containerApps/write` es una acción amplia de Azure RBAC: el límite por servicio y la verificación de configuración/digest se aplican en el ejecutor; el owner debe revisar esta limitación antes de aplicar el plan.

## Recuperación y recibos

Cada recibo incluye destino, Environment GitHub, suscripción, RG, Environment ACA, región, resource ID de la aplicación, contenedor, digest anterior y objetivo y hash de la configuración no secreta. `reconcile-recovery.sh` rechaza un destino o Environment diferente antes de invocar `deploy.sh`. El rollback también exige que el digest actual y el hash de configuración coincidan con los del recibo, para evitar sobrescribir drift concurrente.

## Plan RBAC sin aplicar

Ejemplo futuro de planificación para los cinco servicios iniciales:

```powershell
./ops/azure/github-runner-h5/prepare-cd-rbac.ps1 -Destination chile-shared
```

Para una selección adicional se requiere declarar servicios y `-AuthorizeAdditionalServices`; el plan aún debe ser revisado por el owner. `-Apply` no forma parte de esta fase.

### Verificación de exclusividad de la variable

Antes de cada apertura, un actor con acceso de lectura autorizado lista variables de `Taller-SW-Web` en organización y repositorio y confirma que `AZURE_CHILE_DEPLOY_ENABLED` no aparece en ninguno; luego lista las variables del Environment y confirma que aparece únicamente en `azure-h5-chile`. El workflow no consulta el endpoint REST de variables y no requiere PAT, GitHub App adicional ni permisos amplios. Si los listados no se pueden leer o existe un homónimo superior, no abrir la ventana.

Comandos de lectura para un operador ya autenticado y autorizado (solo muestran nombres coincidentes):

```bash
gh api --paginate orgs/Taller-SW-Web/actions/variables --jq '.variables[]? | select(.name == "AZURE_CHILE_DEPLOY_ENABLED") | .name'
gh api --paginate repos/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/variables --jq '.variables[]? | select(.name == "AZURE_CHILE_DEPLOY_ENABLED") | .name'
gh api --paginate repos/Taller-SW-Web/G6-Productos-Ofertas-backend/environments/azure-h5-chile/variables --jq '.variables[]? | select(.name == "AZURE_CHILE_DEPLOY_ENABLED") | .name'
```

Los dos primeros comandos deben producir salida vacía; el tercero exactamente una coincidencia. No operar si falta el permiso de lectura del scope correspondiente.
