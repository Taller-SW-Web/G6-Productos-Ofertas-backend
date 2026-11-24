# CD H5 sobre el runtime compartido de Chile

## Alcance

`chile-shared` reutiliza `rg-g6-aca-chile` y `env-g6-phase1-chile`. El CD solo actualiza el contenedor de aplicación ya existente del servicio pedido, usando una imagen GHCR fijada por digest. No crea ACA ni altera Caddy, identidad, configuración, secretos, escala, probes, ingress o tráfico.

Las nueve aplicaciones se pueden seleccionar individualmente. `all` se rechaza para Chile. El plan RBAC inicial usa Catalog, Inventory, Pricing, Promotions y Gateway; los otros cuatro requieren selección expresa y autorización del owner RBAC.

## Ventana de despliegue

Un owner autorizado administra manualmente la variable `AZURE_CHILE_DEPLOY_ENABLED` del GitHub Environment `azure-h5-chile`. El workflow la consume desde `vars` dentro del job `deploy`, después de la aprobación humana del Environment y antes de solicitar OIDC. `deploy.sh` vuelve a rechazar el despliegue Chile si el valor no es exactamente `true`; inspect y recuperación supervisada no están sujetos a esta variable.

1. Antes de abrir la ventana, confirmar Marketplace protegido, aprobación humana requerida, autoaprobación deshabilitada, política `master` únicamente y bypass administrativo deshabilitado.
2. Verificar con permisos de lectura que el nombre `AZURE_CHILE_DEPLOY_ENABLED` no exista en variables de repositorio ni de organización; debe existir exclusivamente en el Environment `azure-h5-chile`. No puede haber homónimos en scopes superiores que actúen como fallback del contexto `vars`.
3. Para abrir la ventana, establecer `AZURE_CHILE_DEPLOY_ENABLED` con valor exacto `true` en `azure-h5-chile`. La aprobación humana del Environment sigue siendo obligatoria. Preparación, auditoría de dependencias y publicación de imágenes pueden avanzar con la ventana cerrada porque no modifican las ACA.
4. Ejecutar el workflow manual existente `CD Azure Container Apps H5`, elegir `chile-shared`, seleccionar un servicio individual y proporcionar el SHA completo vigente de `master` con CI exitosa.
5. Para cerrar la ventana, quitar la variable o asignarle un valor distinto de `true`; esto bloquea nuevos despliegues antes de OIDC, pero no cancela ni invalida retroactivamente un job activo. Antes de comenzar Marketplace protegido, cerrar la ventana y comprobar en Actions que no existan ejecuciones CD activas o pendientes que puedan continuar.
6. No utilizar el piloto histórico #234 durante ventanas protegidas de Marketplace. No iniciar un rollback al cerrar la ventana. Una recuperación solo puede partir del mismo run, su aprobación del Environment y sus recibos completos para el mismo destino y recurso. El paso de recuperación conserva la revisión humana y no usa la variable como autorización de rollback.

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
