# Cierre Técnico APIM H5 — `apim-g6-productos-chile`

**Fecha:** 2026-11-27
**Suscripción:** `REDACTED` (`Azure for Students`)
**Región:** `chilecentral`

---

## 1. Estado de Infraestructura y Configuración

| Componente | Recurso / Valor verificado |
|---|---|
| **VNet compartida** | `vm-g6-backendVNET` (`10.0.0.0/16`, `rg-g6-productos-azure`) |
| **Subred dedicada APIM** | `snet-g6-apim` (`10.0.1.0/28`, `delegations: []`) |
| **NSG dedicado APIM** | `nsg-g6-apim` (Inbound `3443` `ApiManagement`, `6390` `AzureLoadBalancer`, `80/443` `Internet`; Outbound `Storage`, `Sql`, `AzureKeyVault`, `AzureMonitor`) |
| **APIM** | `apim-g6-productos-chile` (`Developer` clásico, `capacity: 1`, `virtualNetworkType: External`) |
| **URL pública APIM** | `https://apim-g6-productos-chile.azure-api.net` |
| **URL base API** | `https://apim-g6-productos-chile.azure-api.net/api/v1` |
| **IP pública APIM** | `57.156.40.55` (`57.156.40.55/32`, administrada por APIM) |
| **API importada** | `g6-productos-ofertas` (`path: api/v1`, `protocols: ["https"]`, `subscriptionRequired: false`) |
| **Backend Gateway** | `https://api-gateway.calmgrass-aec0b33c.chilecentral.azurecontainerapps.io/api/v1` (sin duplicación de `/api/v1`) |
| **ACA Environment** | `env-g6-phase1-chile` (`vnetConfiguration: null`, sin modificar) |
| **Modalidad anti-bypass** | Modalidad B en `api-gateway`: `external: true`, `ipSecurityRestrictions: [{"name":"allow-apim-1","action":"Allow","ipAddressRange":"57.156.40.55/32"}]` |
| **Observabilidad** | `law-g6-apim-chile` (30 días) + `appi-g6-apim-chile` + logger `g6-h5-candidate-applicationinsights` (`Monitoring Metrics Publisher`, `body.bytes: 0`, solo `x-correlation-id`) |

---

## 2. Procedencia, Paridad OpenAPI y Políticas

- **Docs SHA (`operation-security.json`):** `5f30802129ba4bbc0674dcc5878f10065f443118`
- **Gateway SHA (`operation-security.json`):** `097dac1bf4a8dcf5c6e799742d2df340f6d893d5`
- **Operaciones importadas:** `145 / 145` operaciones del catálogo candidato (`0` operaciones `x-internal` importadas; `4` rutas G5 pendientes excluidas).
- **Políticas aplicadas:**
  - Política global de API (`ops/azure/apim/policies/api.xml`): validación/generación UUID `X-Correlation-Id`, CORS explícito sin wildcard (`https://apim-g6-productos-chile.azure-api.net`), `<forward-request buffer-request-body="false" buffer-response="false" />`.
  - Políticas por operación (`ops/azure/apim/policies/operation-secured.xml`): `145 / 145` aplicadas sin errores (`<validate-jwt>` contra G7 OIDC/JWKS/issuer + audiencia `api-productos` para M2M, validación de `tipo`, `roles`, `scope`/`scp`, `client_id`/`azp`/`sub`, más perfiles RL-01..RL-06).
  - Correcciones reales aplicadas al XML para el compilador Razor/.NET Framework de APIM: llaves `{ return true; }`, `.Split(new[] {','}, ...)` y orden XSD `<audiences>` antes de `<issuers>`.

---

## 3. Reconciliación IaC (PR #305)

- `main.bicep` y `validate-parameters.py` implementan despliegue en dos etapas (`deploymentStage: 'infrastructure' | 'effective'`), manteniendo íntegras todas las validaciones de seguridad en `effective` (`publicationMode == 'effective'`, `effectivePublication.authorized == true`, `expectedApimOriginCidrs`, `directRoutesBlocked == true`).
- `export-apim-openapi.py` normaliza determinísticamente OpenAPI 3.1.0 (`exclusiveMinimum: 0`, `type: [T, "null"]`, `info.summary`) a OpenAPI 3.0.3 compatible con el importador de APIM sin alterar los hashes contractuales versionados.
- `parameters.chile.example.json` documenta la parametrización reproducible para `chilecentral` sin almacenar secretos.

---

## 4. Pruebas Ejecutadas y Bloqueo Externo G7

### Pruebas seguras ejecutadas en vivo
- `Gateway_DirectBypass_403`: `GET https://api-gateway.calmgrass-aec0b33c.chilecentral.azurecontainerapps.io/health` -> **HTTP 403** (`PASS`).
- `APIM_NoAuth_401`: `GET https://apim-g6-productos-chile.azure-api.net/api/v1/productos` sin `Authorization` -> **HTTP 401** con `x-correlation-id` UUID (`PASS`).
- `APIM_InvalidJWT_401`: `Authorization: Bearer invalid.jwt.token` -> **HTTP 401** (`PASS`).
- `APIM_InvalidCorrelation_400`: `X-Correlation-Id: not-a-uuid` -> **HTTP 400** (`PASS`).
- `APIM_Unknown_404` y `APIM_InternalExcluded_404`: rutas desconocidas y `x-internal` -> **HTTP 404** (`PASS`).
- `az bicep build` + `unittest` (`ops/azure/apim/tests`): **30/30 PASS**.

> **Nota operativa de Azure Resource Health (`14:46Z`):** tras las pruebas en vivo de `14:30Z`, Azure inició una actualización automática de plataforma sobre la instancia única `Developer` (`availabilityState: Unavailable` — *"Your API Management service is being upgraded to a newer version"*), interrumpiendo temporalmente los puertos `443` y `3443` sin afectar `api-gateway` (`403` directo verificado). Una vez que Resource Health vuelva a `Available`, ejecutar `ops/azure/apim/scripts/Verificar-G6.ps1` para re-confirmar las sondas `CORS_Preflight_Allowed` y `CORS_Preflight_Denied`.

### Prueba positiva con JWT real de G7 (`BLOCKED_EXTERNAL_G7_CREDENTIALS`)
- **Motivo:** G6 no dispone de credenciales de consumidor emitidas por G7 (ni debe firmar tokens sintéticos).
- **Procedimiento autorizado para ejecutar con G7 / módulo consumidor:**
  1. Obtener un JWT real de G7 (`POST https://g7-auth-service.onrender.com/api/v1/auth/token`) para un cliente autorizado (ej. `modulo-marketplace` con `aud: "api-productos"` y `scope: "catalogo:leer"`).
  2. Ejecutar `ops/azure/apim/scripts/Verificar-G6.ps1 -JwtToken "<JWT_REAL_G7>"` (o `GET https://apim-g6-productos-chile.azure-api.net/api/v1/productos?canal=MARKETPLACE&pagina=1&tamanio=1` con `Authorization: Bearer <JWT_REAL_G7>` y `X-Correlation-Id: <UUID>`).
  3. Verificar respuesta `HTTP 200`, retorno de `x-correlation-id` hasta el microservicio `catalog-svc`, y casos `403` (scope/cliente no autorizado) y `429` (ráfaga con `Retry-After`).

---

## 5. Rollback Operativo

- **Gateway (`api-gateway`):** `ops/azure/apim/scripts/Conectar-APIM.ps1 -RollbackOnly` restaura las reglas `ipSecurityRestrictions` desde el snapshot previo (`$env:TEMP\api-gateway-ip-restrictions-rollback.json`).
- **APIM:** `ops/azure/apim/scripts/Eliminar-APIM.ps1 -AuthorizeDelete` elimina únicamente la instancia APIM preservando `vm-g6-backendVNET`, `snet-g6-apim`, `nsg-g6-apim`, `appi-g6-apim-chile` y las 9 ACA.
