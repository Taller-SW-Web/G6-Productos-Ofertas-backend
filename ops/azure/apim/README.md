# Preparación APIM H5 (sin aprovisionamiento)

Este paquete prepara la importación y las políticas de APIM Developer clásico. No crea recursos: el despliegue requiere aprobación y parámetros de red, identidad, observabilidad y cuotas que aún no están acreditados.

## Contrato filtrado

El filtro importa exclusivamente operaciones del registro `CONTRACT_ROUTES`. Comprueba método+ruta contra el OpenAPI y no acepta las cinco operaciones `x-internal`; mantiene las cuatro G5 fuera del documento salvo `--enable-g5`. Cada operación conserva `operationId` y registra `apimOperationId` calculado con la normalización oficial APIM (minúsculas, secuencias no alfanuméricas a guion, recorte, truncado a 76). Colisiones o nombres incompatibles fallan sin sufijos automáticos. El manifiesto conserva los SHA Docs/Gateway y liga el conjunto método/ruta/IDs al contenido filtrado mediante hashes canónicos.

```powershell
python ops/azure/apim/filter-openapi.py `
  --openapi <openapi-0.7.0-rc.3.yaml> `
  --gateway-routes apps/api-gateway/src/routing/contract-routes.ts `
  --g5-routes apps/api-gateway/src/routing/g5-h5-routes.ts `
  --docs-sha <sha-docs> --gateway-sha <sha-gateway> `
  --output ops/azure/apim/openapi/gateway-filtered.json `
  --manifest ops/azure/apim/openapi/operation-security.json
```

G5 queda desactivado si no se usa `--enable-g5`. No se incluye valor de ejemplo con datos de producción.

## Infraestructura

`main.bicep` define APIM Developer clásico con inyección VNet externa para HTTPS de clientes y conectividad saliente a Gateway. La URL de origen del Gateway debe ser privada y resolverse desde la subred dedicada. La plantilla parametriza IDs de subred, URL/DNS, issuer/JWKS/audience, orígenes CORS, límites y logger; no contiene secretos, identificadores de red ni parámetros de laboratorio inventados.

Las policies validan JWT antes de limitar operaciones protegidas; el sujeto se toma de `Jwt.Subject` del token que valida `validate-jwt`, rechazando subject vacío, y la clave combina sujeto+`operationId` contractual. La policy pública mantiene su comportamiento IP+operación. El Gateway conserva autoridad de roles, scopes, clientes e introspección. La policy de burst admite una ventana de hasta 300 segundos; APIM devuelve 429 con `Retry-After`. La cuota por clave admite ventanas desde 300 segundos y, al agotarse, responde 403 con `Retry-After`. La observabilidad captura solo cabeceras de correlación, nunca cuerpos. No se registran tokens.

La prevención de bypass requiere que el owner de infraestructura de Gateway permita tráfico de entrada únicamente desde la subred/egress aprobada de APIM y que la ruta del backend APIM resuelva a un destino privado. Esta plantilla no cambia el ingress actual del Gateway ni el tráfico.

## Validación local sin Azure

```powershell
python -m unittest discover ops/azure/apim/tests -v
python ops/azure/apim/validate-parameters.py <parametros-revisados.json> --openapi ops/azure/apim/openapi/gateway-filtered.json --manifest ops/azure/apim/openapi/operation-security.json
az bicep build --file ops/azure/apim/main.bicep --outfile $env:TEMP/apim-h5.json
```

No ejecutar `az deployment`, `what-if`, importaciones APIM ni comandos que creen o modifiquen recursos.

El preflight verifica que el parámetro `filteredOpenApi`, el archivo filtrado y el manifiesto coincidan exactamente en SHA canónico y en operationId/método/ruta; un manifiesto viejo o una sustitución del parámetro falla antes de cualquier ejecución de Azure. La importación mantiene `servers=/api/v1`, el sufijo público APIM `api/v1` y `gatewayBackendUrl=https://<hostname-privado-aprobado>/api/v1`; una operación pública `/api/v1/productos` llega al Gateway como `/api/v1/productos`. No se añade `rewrite-uri`.

## Plan de aceptación APIM-T01–T08 / RL-01–RL-06

| Caso | Criterio verificable | Estado |
|---|---|---|
| APIM-T01 | Importar solo operationIds en `operation-security.json`; comparación automática de operaciones | `BLOCKED_INFRA` |
| APIM-T02 | Confirmar que las cinco operaciones `x-internal` no se importan ni responden | Estático PASS; instancia `BLOCKED_INFRA` |
| APIM-T03 | Las cuatro rutas G5 no existen con el manifiesto predeterminado | Estático PASS; instancia `BLOCKED_INFRA` |
| APIM-T04 | Rechazo de issuer, firma o audience incorrectos; JWT válido pasa al Gateway | `BLOCKED_INFRA` |
| APIM-T05 | CORS permite solo orígenes explícitos y rechaza wildcard/otros orígenes | Estático PASS; instancia `BLOCKED_INFRA` |
| APIM-T06 | Cliente no puede alcanzar Gateway evitando APIM | `BLOCKED_INFRA`: control de ingress del Gateway pendiente |
| APIM-T07 | Correlación W3C viaja a Gateway y aparece en logs sin token/cuerpo | Estático PASS; instancia/logger `BLOCKED_INFRA` |
| APIM-T08 | Reversión restaura route/policy versionada y deja el ingress actual del Gateway intacto; cualquier DNS/traffic switch necesita aprobación | `BLOCKED_INFRA`: procedimiento y ventana requieren aprobación |
| RL-01 | Identidad validada y operationId forman la llave de burst | Estático PASS |
| RL-02 | Umbral excedido devuelve 429 con `Retry-After` | `BLOCKED_INFRA` |
| RL-03 | Reinicio de ventana restablece el burst según APIM | `BLOCKED_INFRA` |
| RL-04 | Cuota por identidad y operación se aplica en el período configurado | Estático PASS; instancia `BLOCKED_INFRA` |
| RL-05 | Operación pública usa IP + operationId como llave | Estático PASS |
| RL-06 | Una identidad no consume la cuota de otra identidad/operación | `BLOCKED_INFRA` |

## Aprobaciones externas exactas

- **Owner de red/Azure:** resource IDs de VNet/subred dedicada APIM, NSG/UDR, DNS privado, hostname del Gateway y conectividad privada probada.
- **Owner de Gateway/Backend:** ingreso restringido a APIM y prueba negativa de acceso directo; no se toca el ingress en este PR.
- **Owner G7:** valores oficiales de issuer, OpenID/JWKS y audience, y aceptación del perfil JWT.
- **Owner plataforma/APIM:** orígenes CORS, cuotas y límites acordados, logger APIM, modelo de reversión y aprobación de laboratorio.
- **Owner Docs + Backend:** fusionar y homologar el contrato y Gateway candidatos antes de importar un paquete definitivo.

Ningún test que necesite una instancia APIM real puede reportarse PASS hasta disponer de esos recursos y aprobaciones.
