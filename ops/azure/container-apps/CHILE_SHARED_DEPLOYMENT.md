# CD H5 sobre el runtime compartido de Chile

## Alcance

`chile-shared` reutiliza `rg-g6-aca-chile` y `env-g6-phase1-chile`. El CD solo actualiza el contenedor de aplicación ya existente del servicio pedido, usando una imagen GHCR fijada por digest. No crea ACA ni altera Caddy, identidad, configuración, secretos, escala, probes, ingress o tráfico.

Las nueve aplicaciones se pueden seleccionar individualmente. `all` se rechaza para Chile. El plan RBAC inicial usa Catalog, Inventory, Pricing, Promotions y Gateway; los otros cuatro requieren selección expresa y autorización del owner RBAC.

## Ventana de despliegue

Un owner autorizado administra manualmente la variable del GitHub Environment `azure-h5-chile`:

1. Antes de abrir la ventana, confirmar Marketplace protegido, aprobación humana requerida, autoaprobación deshabilitada, política `master` únicamente y bypass administrativo deshabilitado.
2. Para abrirla, establecer `AZURE_CHILE_DEPLOY_ENABLED` con valor exacto `true` en `azure-h5-chile`.
3. Ejecutar el workflow manual existente `CD Azure Container Apps H5`, elegir `chile-shared`, seleccionar un servicio individual y proporcionar el SHA completo vigente de `master` con CI exitosa. La aprobación humana del Environment sigue siendo obligatoria.
4. Para cerrar la ventana, quitar la variable o asignarle un valor distinto de `true`. Los siguientes despliegues fallan antes de autenticarse en Azure. No iniciar un rollback al cerrar la ventana.
5. Una recuperación solo puede partir del mismo run, su aprobación del Environment y sus recibos completos para el mismo destino y recurso. El paso de recuperación conserva la revisión humana; no se usa la variable de apertura como autorización de rollback.

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
