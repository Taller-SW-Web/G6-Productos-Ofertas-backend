# Coordinación G7 — APIM H5 (`apim-g6-productos-chile`)

Documento operativo con valores reales verificados en Azure para que **G7 (Seguridad)** y los módulos consumidores (**G1 Marketplace**, **G2 Despacho**, **G3 Chatbot**, **G4 Retail**, **G5 Ventas/Postventa**) completen el registro/validación de integración H5.

---

## 1. Datos de la instancia APIM (verificados en vivo)

| Campo | Valor verificado |
|---|---|
| **Nombre APIM** | `apim-g6-productos-chile` |
| **SKU / Modo** | `Developer` clásico (`capacity: 1`), VNet `External` (`snet-g6-apim`, `10.0.1.0/28` en `vm-g6-backendVNET`) |
| **Región** | `chilecentral` |
| **URL pública exacta** | `https://apim-g6-productos-chile.azure-api.net` |
| **URL base de las APIs** | `https://apim-g6-productos-chile.azure-api.net/api/v1` |
| **IP pública (entrada y salida)** | `57.156.40.55` (`57.156.40.55/32`, administrada por APIM) |
| **Suscripción APIM (`Ocp-Apim-Subscription-Key`)** | **NO requerida** (`subscriptionRequired: false`); autenticación exclusivamente por JWT de G7 |

> **Nota sobre hostname/IP:** Si G7 mantiene allowlists de origen o CORS/redirect por hostname o IP, debe autorizar `https://apim-g6-productos-chile.azure-api.net` (y, si aplica control por IP, `57.156.40.55/32`). Al usar IP administrada por APIM, una eliminación/recreación futura del recurso puede asignar una IP distinta.

---

## 2. Configuración JWT vigente en APIM (alineada con G7 y OpenAPI)

| Parámetro | Valor configurado |
|---|---|
| **Issuer (`iss`)** | `https://g7-auth-service.onrender.com/api/v1/auth` |
| **OpenID Connect Discovery** | `https://g7-auth-service.onrender.com/api/v1/auth/.well-known/openid-configuration` |
| **JWKS URI** | `https://g7-auth-service.onrender.com/api/v1/auth/.well-known/jwks.json` |
| **Algoritmo JWT** | `RS256` (`kid` observado en JWKS: `mjorpqaOV8Yh3izXYLnfY2OnO3zBQe3DgH9dXrOXnjk`) |
| **Audiencia (`aud`) M2M** | `api-productos` (preservada según contrato OpenAPI; exigida en tokens `tipo="servicio"`) |

### Claims utilizados por APIM (`policies/operation-secured.xml`)

- **`tipo`**: distingue tokens humanos (`"acceso"`) de tokens M2M (`"servicio"`).
- **`sub`**: identificador del sujeto/consumidor; obligatorio (no vacío) y usado como llave de rate-limit/cuota (`sub:operationId`).
- **`roles`** (tokens `tipo="acceso"`): lista separada por espacios o comas; actualmente el rol administrativo contractual es `GESTOR_COMERCIAL`.
- **`scope` / `scp`** (tokens `tipo="servicio"`): lista separada por espacios o comas con los scopes contractuales de G6.
- **`client_id` / `azp` / `sub`** (tokens `tipo="servicio"`): identificador del cliente técnico verificado contra la allowlist contractual de cada operación.

---

## 3. Matriz de permisos aplicable (145 operaciones importadas, 5 `x-internal` excluidas)

- **Clientes técnicos contractuales:** `modulo-marketplace`, `modulo-chatbot`, `modulo-ventas`, `modulo-postventa`, `modulo-despacho`, `modulo-retail`, `modulo-productos`.
- **Scopes contractuales en catálogo APIM:**
  - Catálogo y Taxonomía: `catalogo:leer`, `productos:fisicos:leer`
  - Precios y Combos: `precios:leer`, `combos:leer`
  - Promociones, Cupones y Recomendaciones: `promociones:leer`, `promociones:evaluar`, `cupones:validar`, `recomendaciones:leer`
  - Inventario: `inventario:disponibilidad:leer`, `inventario:reservar`, `inventario:consumir`, `inventario:liberar`, `inventario:conciliar-offline`, `inventario:reintegrar`, `inventario:operaciones:leer`, `inventario:incidencias:reportar`, `inventario:incidencias:resolver`
- **Rol humano administrativo:** `GESTOR_COMERCIAL`.

---

## 4. Pendientes de confirmación por G7

1. Confirmar que los tokens emitidos por G7 para consumidores M2M de G6 incluyen `aud: "api-productos"`, `tipo: "servicio"`, `sub` no vacío, `scope`/`scp` y `client_id` (o `azp`/`sub`) coincidente con la matriz contractual.
2. Confirmar el estado de registro y provisión efectiva de grants/credenciales para los módulos consumidores (`modulo-marketplace`, `modulo-chatbot`, `modulo-ventas`, `modulo-postventa`, `modulo-despacho`, `modulo-retail`).
3. Confirmar si G7 requiere registrar/autorizar el hostname `apim-g6-productos-chile.azure-api.net` o su IP `57.156.40.55/32` en alguna lista de confianza (para consumo de JWKS/OIDC no hay restricción observada desde Internet).

---

## 5. Endpoints representativos para retest

Base: `https://apim-g6-productos-chile.azure-api.net/api/v1` (enviar `Authorization: Bearer <JWT_G7>` y `X-Correlation-Id: <UUID>`, sin `Ocp-Apim-Subscription-Key`):

1. **Catálogo comercial (`catalogo:leer`, `modulo-marketplace` / `modulo-chatbot`):**
   `GET /productos?canal=MARKETPLACE&pagina=1&tamanio=5`
2. **Categorías (`catalogo:leer`):**
   `GET /categorias`
3. **Precios por SKU (`precios:leer`):**
   `GET /precios?skus=<SKU>&canal=MARKETPLACE`
4. **Disponibilidad comercial (`inventario:disponibilidad:leer`):**
   `GET /inventario/disponibilidad/comercial?skus=<SKU>&canal=MARKETPLACE`
5. **Administración (`tipo="acceso"`, rol `GESTOR_COMERCIAL`):**
   `GET /productos` (sin filtro comercial o rutas administrativas según contrato).
6. **Prueba negativa sin token / token inválido (esperado `401 TOKEN_INVALIDO`):**
   `GET /productos` sin cabecera `Authorization`.

---

## 6. Mensaje breve listo para enviar a G7

> Hola equipo G7, ya tenemos aprovisionado el **APIM Developer clásico** de **G6 Productos y Ofertas** en Azure (`chilecentral`):
> - **URL base APIs:** `https://apim-g6-productos-chile.azure-api.net/api/v1`
> - **IP pública APIM:** `57.156.40.55`
> - **Autenticación:** solo JWT de G7 (`RS256`, issuer `https://g7-auth-service.onrender.com/api/v1/auth`, JWKS `.../.well-known/jwks.json`, audiencia M2M `api-productos`). **No** exigimos `Ocp-Apim-Subscription-Key`.
> - **Claims validados:** `tipo` (`acceso`/`servicio`), `sub`, `roles` (`GESTOR_COMERCIAL`), `scope`/`scp` y `client_id`/`azp`.
>
> ¿Nos confirman por favor: (1) si necesitan autorizar `apim-g6-productos-chile.azure-api.net` o `57.156.40.55/32`, y (2) el estado de provisión de grants/tokens reales para que los módulos consumidores puedan ejecutar el retest sobre `GET /api/v1/productos?canal=MARKETPLACE` y `GET /api/v1/categorias`?
