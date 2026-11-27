# Preparación APIM H5 (sin aprovisionamiento)

La plantilla actual usa por defecto `candidateApiName=g6-h5-candidate` y
`candidateApiPath=h5-candidate/api/v1`. El preflight exige ambos parámetros
explícitos en el documento de despliegue y rechaza la ruta operativa `api/v1`.
El Gateway de Azure continúa público: el gate de red `directRoutesBlocked`
del validador no puede pasar en este entorno sin un cutover posterior autorizado.
No aplicar la plantilla ni interpretar un `what-if` vacío como APIM operativo.

Este paquete prepara la importación, el manifiesto de seguridad enriquecido, perfiles de protección parametrizados y las políticas de Azure API Management (`Developer` clásico para laboratorio o reutilización de instancia compatible mediante `reuseExistingApim`). No crea ni muta recursos Azure: el despliegue requiere aprobación operativa y parámetros de red, identidad, observabilidad y cuotas acreditados.

## Contrato filtrado y manifiesto enriquecido (`APIM-C01`, `APIM-C03`)

`filter-openapi.py` separa explícitamente:
1. `contractInventory` (154 operaciones de OpenAPI `0.7.0-rc.3`).
2. `gatewayStaticRegistry` (registro base y overlay G5).
3. `candidateCatalog` (`operations` candidatos APIM).
4. `effectivePublication` (importación efectiva **fail-closed**: `environmentEnabled=false` por defecto hasta recibir `--enabled-providers`, `--security-profile`, allowlist pública autorizada y resolución de allowlists M2M).

Excluye las cinco operaciones `x-internal`, mantiene fuera de importación contractual las dos operaciones legacy de Pricing y deja las cuatro rutas G5 fuera del artefacto predeterminado.

El uso de `--enable-g5` por sí solo no autoriza publicación operativa: requiere además `--g5-authorized` explícito. Para operaciones M2M, la falta de `x-service-audience` o `x-required-scope` bloquea el catálogo; la falta de `x-allowed-client-ids` (ej. `consultarDisponibilidadCombo`) se registra como `clientAllowlistStatus: "PENDING_G7_ALLOWLIST"` sin inventar clientes y bloquea `effectivePublication` (`--effective-publish`). Operaciones con seguridad alternativa (`obtenerCombo`, `consultarDisponibilidadCombo`) conservan ambas modalidades en `securityAlternatives` (`identityType: "human_or_m2m"`).

Cada entrada de `operations` incluye:
- `operationId`, `apimOperationId`, `method`, `path`, `secured`
- `authSchemes`, `identityType` (`public`, `human`, `m2m`), `issuerRequired`, `audienceRequired`, `audience`
- `scopes`, `roles`, `allowedClients`, `introspectionRequired`
- `exposureProfile`, `rateProfile`, `environmentEnabled`, `g5OptIn`

```powershell
python ops/azure/apim/filter-openapi.py `
  --openapi ..\docs\contratos\http\openapi.yaml `
  --gateway-routes apps/api-gateway/src/routing/contract-routes.ts `
  --g5-routes apps/api-gateway/src/routing/g5-h5-routes.ts `
  --docs-sha 490172c11cb4b83ddd1996f8d5834d0402184cf8 --gateway-sha 1b90543dc39a8919fd94f0e059d10e1002b3b2a9 `
  --output ops/azure/apim/openapi/gateway-filtered.json `
  --compact-output ops/azure/apim/openapi/gateway-filtered.compact.json `
  --manifest ops/azure/apim/openapi/operation-security.json
```

## Orden de políticas, perfiles y correlación (`APIM-C02`, `APIM-C04`, `APIM-C05`)

1. **Correlación (`api.xml`):** valida `X-Correlation-Id` como UUID (genera uno nuevo si falta; rechaza con `400 VALIDACION` si es inválido o duplicado) y lo propaga en solicitud, respuesta exitosa, rechazos 401/403/429 y `<on-error>`.
2. **CORS (`api.xml`):** orígenes explícitos sin wildcard, `allow-credentials="false"`, exponiendo `Content-Disposition`, `Location`, `Retry-After` y `X-Correlation-Id`.
3. **Identidad (`operation-secured.xml`):** `validate-jwt` contra `g7-openid-config-url` y `g7-issuer`. Solo las operaciones M2M (o con `audienceRequired=true`) exigen audiencia técnica (`g7-audience`), sin imponerla a tokens humanos cuando el contrato G7 no la establece. Rechazos sin identidad válida devuelven `401 TOKEN_INVALIDO`.
4. **Autorización en borde (`operation-secured.xml`):** valida `tipo` (`acceso` vs `servicio`), rol, scope y allowlist de clientes declarados por el contrato, devolviendo `403 SCOPE_INSUFICIENTE`. Gateway y provider mantienen sus propias barreras e introspección.
5. **Clave de tasa confiable:** `sub` del JWT ya validado para rutas protegidas; `context.Request.IpAddress` para lecturas públicas (nunca `X-Forwarded-For` ni `X-Real-IP`).
6. **Perfiles de protección (`main.bicep`):** parámetros separados para `commercial_read`, `admin_read`, `business_write`, `multipart_import`, `expensive_export` y `g5_protected`, cubriendo ráfaga (`rate-limit-by-key`), cuota por ventana (`quota-by-key`) y concurrencia (`limit-concurrency` en operaciones costosas/multipart/G5). Los valores por defecto son fixtures de laboratorio, no límites productivos aprobados.
7. **Transporte y diagnóstico:** `<forward-request buffer-request-body="false" />` preserva streaming multipart y descargas; `apiDiagnostics` registra únicamente `x-correlation-id` con `body.bytes = 0`, sin tokens ni cuerpos en Application Insights.

## Infraestructura, red privada y anti-bypass (`APIM-C06`)

- `main.bicep` permite aprovisionar el candidato `Developer` clásico de laboratorio (`reuseExistingApim = false`) o reutilizar una instancia compatible existente (`reuseExistingApim = true`).
- La comunicación APIM → Gateway admite dos modalidades válidas en ACA (`validate-parameters.py` / `apim-live-acceptance.mjs`):
  - **Modalidad A (Gateway interno):** `external = false`, `vnetConfiguration != null`, DNS privado y conectividad privada verificada.
  - **Modalidad B (Gateway externo con allowlist):** `external = true`, reglas `ipSecurityRestrictions` exclusivamente `Allow` (sin mezclar `Allow`/`Deny` ni usar `0.0.0.0/0`), restringidas a `expectedApimOriginCidrs` y con bloqueo real desde orígenes no autorizados.
- Los ocho microservicios permanecen sin ingress público (`external: false`).
- Rollback reversible mediante exportación previa de revisión, `operationSetSha256` y hashes SHA256 calculados sobre el XML real de políticas obtenido vía `az apim` / `az rest --method get`.
- Las pruebas k6 (`apim-rl-k6.js`) exigen explícitamente un manifiesto efectivo autorizado (`APIM_EFFECTIVE_MANIFEST_PATH` con `publicationMode="effective"` y `effectivePublication.authorized=true`, nunca el catálogo candidate).

## Plan de aceptación APIM-T01–T08 / RL-01–RL-06

| Caso | Criterio canónico | Estado |
|---|---|---|
| APIM-T01 | HTTPS hacia operación autorizada y owner esperado | Estático preparado; instancia `BLOCKED_INFRA` |
| APIM-T02 | JWT válido e inválido (`401`, sin exposición de token) | Estático preparado; instancia `BLOCKED_INFRA` |
| APIM-T03 | Scope y cliente incorrectos (`403`, sin llamada upstream) | Estático preparado; instancia `BLOCKED_INFRA` |
| APIM-T04 | CORS (orígenes explícitos, `Content-Disposition`, `Location`, sin wildcard) | Estático preparado; instancia `BLOCKED_INFRA` |
| APIM-T05 | Antiabuso integral, burst `429`, cuota, aislamiento, concurrencia y anti-bypass | Estático preparado; instancia `BLOCKED_INFRA` |
| APIM-T06 | Ruta desconocida o las 5 privadas `404` sin llegar al provider | Estático preparado; instancia `BLOCKED_INFRA` |
| APIM-T07 | Correlación `X-Correlation-Id` UUID preservada/generada en todo flujo | Estático preparado; instancia `BLOCKED_INFRA` |
| APIM-T08 | Comparación privada y rollback de revisión/políticas | Estático preparado; instancia `BLOCKED_INFRA` |
| RL-01..RL-06 | Perfiles burst, cuota, concurrencia, aislamiento y anti-bypass según Docs | Estático preparado; instancia `BLOCKED_INFRA` |
