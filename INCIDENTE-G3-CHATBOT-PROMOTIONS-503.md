# Incidente G3 Chatbot — 503 en evaluarPromociones

**Corte del diagnóstico:** 2026-11-25 00:24 UTC
**Ambiente:** Azure for Students, `rg-g6-aca-chile`, Chile Central
**Correlation ID reportado:** `afa0459f-972e-44b9-90e3-4d00651313ac`
**Rama:** `trabajo/castilla/chatbot-evaluacion-promociones-503` (worktree independiente desde `origin/master`)

## Conclusión ejecutiva

La causa raíz del 503 está **confirmada**: Promotions opera efectivamente en `PUBLIC_READ_ONLY`; con `evaluarPromociones` en la allowlist, su provider selecciona el transporte interno en modo público y omite `Authorization`. Catalog y Pricing están en `G7_AUTHENTICATED`, por lo que responden `401 TOKEN_INVALIDO` a esas lecturas. El filtro de Promotions convierte ese rechazo upstream en el 503 contractual. Reproducí el mismo 503 en una única evaluación local de lectura y encontré en los logs de Catalog el 401 con el mismo correlation ID.

La autenticación técnica no es el bloqueo: la credencial de `modulo-productos` está disponible y `promotionsServiceTokens` obtuvo/verificó tokens para `catalogo:leer` y `precios:leer`; las tres lecturas autenticadas respondieron 200. El SKU está activo/elegible y su precio live CHATBOT es 249.90 PEN, sin oferta, en la vigencia indicada por Supabase. El proveedor seleccionado es `HttpCommercialContext`; las tres URLs requeridas están configuradas.

También medí un cold start de Promotions: la lectura privada de health devolvió 200 tras 33.9 s después de escala a cero. Esto es consistente con los ~30 s reportados, pero no demuestra la duración del incidente original. No se cambió ninguna escala.

## Recursos y revisión servida

Las revisiones recibieron 100% del tráfico en la inspección. Los cuatro recursos reportaron estado de revisión `Healthy`. Ninguno configura una sonda `Readiness` separada: se observaron sondas `Startup` y `Liveness` (`/health`). “Healthy” es el estado de ACA, no una prueba de readiness funcional de evaluar promociones. Promotions volvió a escala cero después de las solicitudes, conservando `min=0`, `max=1`.

| Servicio | Revisión con tráfico | Imagen (digest) | Health / réplicas listas | Min–max | Ingress |
|---|---|---|---|---|---|
| api-gateway | `api-gateway--mktrestore1124`, 100% | `sha256:2ec4f28ee02c222f5e407caf5ecbd2aae13a158ed3ab1b9509cc6dedb778eed3` | Healthy; 1, reinicios 0 | 0–1 | Externo, puerto 8080 |
| promotions-svc | `promotions-svc--http-4c40b31b-mwgj2k1j`, 100% | `sha256:82c272907449ab290ff7d4239b0a5805e54ed04908bd756479ed899cbd61d143` | Healthy según ACA; 0 réplicas | 0–1 | Interno, puerto 3004 |
| catalog-svc | `catalog-svc--b80jpbt`, 100% | `sha256:7bdb66c1bb94de9861f2c930eb6d7c899730b60fac3457785e1ac71ed766079e` | Healthy; 1, reinicios 0 | 1–1 | Interno, puerto 3001 |
| pricing-svc | `pricing-svc--0000004`, 100% | `sha256:78852699924a1410382d0dd7fff83ae0ae09601aa10c8ca22f9442fd27293048` | Healthy; 1, reinicios 0 en la última consulta | 0–1 | Interno, puerto 3002 |

`inventory-svc` también está interno, Healthy, 1/1 réplica y escala 1–1. Su URL es requisito para que `commercialProvider` seleccione el adaptador HTTP; el handler de evaluación, una vez seleccionado, no consulta Inventario. No se imprimieron valores de URL ni secretos.

El prefijo de revisión de Promotions y el inventario de evidencia del piloto identifican por convención de build el código fuente como `4c40b31b8a12335d4018861ab6d94cfd69536d7b` (el SHA completo existe en GitHub). ACA no expuso una etiqueta OCI firmada que ate el digest a ese SHA, así que la atribución fuente es por el nombre de revisión, no una verificación criptográfica del contenido de la imagen. En los seis archivos de Promotions señalados en el reporte inicial, `integration-providers.ts` y `query-controller.ts` coinciden con el SHA actual de `origin/master`; los cambios entre ese SHA y master en los otros archivos citados corresponden a soporte H5/G5, credenciales/caché por operación y el transporte Service Bus. No encontré un cambio posterior que haya eliminado el handler o cambiado la selección de modo descrita abajo. Las revisiones actuales de Catalog y Pricing tienen digests distintos; ACA no expuso un SHA fuente verificable para esas imágenes.

## Configuración efectiva observable, sanitizada

- **Gateway:** `G6_SECURITY_MODE=PUBLIC_READ_ONLY`, obtenido desde el proceso de la réplica activa. `evaluarPromociones` aparece en `GATEWAY_PUBLIC_OPERATION_IDS`. `GATEWAY_TIMEOUT_MS=60000`. El gateway tiene ingress externo.
- **Promotions (leído en su proceso, tras health):** `G6_SECURITY_MODE=PUBLIC_READ_ONLY`; `PROMOTIONS_PUBLIC_OPERATION_IDS` incluye `evaluarPromociones`; los tres upstreams están definidos como FQDN HTTPS internos de Chile. `PROMOTIONS_SERVICE_TOKEN_URL` está configurado (host `g7-auth-service.onrender.com`) y `PROMOTIONS_SERVICE_CLIENT_SECRET` disponible (booleano true). Issuer/JWKS usan ese host. No se imprimió el secreto ni un JWT. La audiencia solicitada por el client credentials existente es `api-productos`.
- **Catalog:** modo efectivo `G7_AUTHENTICATED`, allowlist pública vacía, audiencia de operación `api-productos`.
- **Pricing:** modo efectivo `G7_AUTHENTICATED`, allowlist pública vacía, audiencia de operación `api-productos`.
- **Gateway:** `G6_SECURITY_MODE=PUBLIC_READ_ONLY`, allowlist incluye `evaluarPromociones`, timeout efectivo 60000 ms. El OpenAPI exige `serviceBearer`; esta discrepancia inbound se mantiene separada de la causa raíz del 503 y requiere coordinación de rollout, no explica los 401 internos.
- **Gateway issuer/audience:** el contrato HTTP define `api-productos`; no se infiere que el Gateway lo esté aplicando a esta operación mientras opera en modo público. Los valores privados del emisor/JWKS no se incluyeron en este informe.
- **Timeouts internos:** `HttpCommercialContext.bounded` delimita el conjunto de lecturas de la cesta a 2.5 s. La obtención de token de servicio tiene deadline de 1 s. El Gateway configurado tiene 60 s. Los aproximadamente 30 s reportados no corresponden por sí solos a ninguno de esos deadlines. Un arranque en frío es posible con escalas mínimas en cero, pero no está demostrado.

## Evidencia de logs y traza

- El correlation ID histórico reportado (`afa0459f-972e-44b9-90e3-4d00651313ac`) no aparece en logs retenidos.
- Sin Log Analytics ni diagnostic setting, no hay retención central. Promotions solo conserva salida de consola de réplicas activas; no se pudo recuperar el request histórico.
- Reproducción local de evaluación, correlation ID `04c02b19-5419-4fea-9f21-1de95fd9766e`: Promotions devolvió `503 SERVICIO_NO_DISPONIBLE` en 475 ms. Catalog registró el `GET` interno con ese mismo ID como `401` en 1 ms (`HTTP_REQUEST_COMPLETED`, 2026-11-25T00:12:26.221Z). Promotions mapea ese rechazo a su 503 genérico.
- El intento no autenticado directo de Pricing en caliente (`3cbb4248-7ac9-449f-b02b-301a2dad2ad8`) respondió `401 TOKEN_INVALIDO` en 27 ms; `at=2026-11-25T00:12:25.799Z`. El primer intento a Pricing, antes de que estuviera caliente, agotó 7 s.
- Las llamadas autenticadas dejaron: `7d404cf2-2090-41b3-a0fb-da69a6e80788` (contexto, 200/1176 ms); `295785d0-58ba-4428-b8ce-0a2363364352` (producto, 200/557 ms); `0efe3cb7-5d3d-4ee5-958b-306be8fcc5c1` (precio, 200/891 ms, `at=2026-11-25T00:11:36.808Z`). En logs visibles, Catalog registró el GET de contexto SKU que Pricing hizo para esa última llamada como 200 a las `00:11:39.166Z`.
- Health de Promotions: `7f296213-f08b-474f-bdd5-83998d1c67a1` agotó 20 s mientras ACA arrancaba; segundo GET `4b564f39-c77a-4d3d-9cc1-1768e5b97170` respondió `200 {status:ok,service:promotions-svc}` en 33908 ms. La hora de inicio UTC de ese segundo GET no quedó capturada en la salida de la herramienta; no se atribuye esa duración al POST original.

## Contraste de código y contratos

1. En SHA desplegado existe `POST /api/v1/promociones/evaluar`, con `@HttpCode(200)`, guard de consulta y `PromotionsQueryService`. La evaluación llama primero a `facts.basket` y luego solo hace lecturas de persistencia.
2. La petición reportada no incluye `coupon_code`. La evaluación no consume cupón, no crea pedidos, no reserva stock ni modifica estado comercial; SPEC-006 además establece explícitamente que evaluar no consume el cupón. Es una ruta apropiada para reproducción de lectura cuando se cuente con identidad autorizada.
3. En Promotions, `commercialProvider` selecciona `HttpCommercialContext` solo si existen URLs para Catalog, Pricing e Inventory; si falta alguna selecciona `blockedCommercialContext`, que responde fail-closed. El `basket` hace, secuencialmente: `GET /api/v1/productos/skus/{sku}/contexto`, `GET /api/v1/productos/{product_id}?canal=CHATBOT` y `GET /api/v1/precios/skus/{sku}?canal=CHATBOT&at={at}`. No consulta Inventario durante esa evaluación.
4. `integration-providers.ts` asigna modo outbound `PUBLIC_READ_ONLY` cuando el modo de Promotions es público y su allowlist no está vacía. Ese modo omite bearer en `InternalHttpReader`. Lo confirmé en runtime: las lecturas internas sin JWT recibieron 401; la misma lectura con el token técnico propio de G6 tuvo éxito.
5. El OpenAPI vigente define `evaluarPromociones` con audiencia `api-productos`, scope `promociones:evaluar`, `serviceBearer` y cliente permitido `modulo-chatbot`; la inscripción de scope está marcada pendiente de registro de seguridad. Gateway en `PUBLIC_READ_ONLY` con la operación allowlisted no demuestra autenticación G3 y es divergente del OpenAPI.
6. El OpenAPI/kit de integración vigente documenta que las llamadas G6 internas de Catalog/Pricing usan el cliente compartido `modulo-productos` con `catalogo:leer` / `precios:leer`; los grants y provisión de credenciales G7 están pendientes. No documenta que `promotions-svc` esté autorizado para esas operaciones. El repositorio de Backend ya usa credenciales específicas `promotions-svc` en otras operaciones H5, pero no cambia por ello el contrato de Catalog/Pricing. No cambié el cliente ni los allowlists sin grant/contrato G7.
7. Los DTO live coinciden con lo que valida `commercial-http.ts`: contexto `{sku,productId,isVariant,active,eligible}`; producto con `product_id`, `tiene_variantes`, `variants[].sku` y marca; precio con `sku`, `channel_id:null`, `precio_regular:249.9`, `precio_oferta:null`, `currency:PEN`, vigencia y versión. No hubo error de DTO.

## SKU, precio, dependencias y reproducción

**SKU:** `ADI-RF3-GRI-38`, producto `abaf9767-7431-9b50-495c-aeb880dc3055`, variante `532ffc0d-d209-2b48-6506-e94f62026e17`; contexto live confirma variante activa y elegible para Catalog. La representación comercial devuelve la misma SKU en `variants`.

**Precio live a `2026-11-25T00:11:36.808Z`:** 249.90 PEN, `precio_oferta=null`, `channel_id=null` (precio general aplicable), vigencia desde `2026-10-01T05:00:00.000Z`, sin vencimiento, `price_version=1`, origen `PRODUCTO`.

**Pruebas reproducibles:** con las mismas rutas y sin `Authorization`, Catalog contexto y producto respondieron 401; Pricing respondió 401 una vez caliente. Luego `promotionsServiceTokens` de la imagen desplegada emitió y verificó JWT con `client_id=modulo-productos`, `aud=api-productos`, scopes concedidos por G7; las tres rutas respondieron 200. No se imprimió ni persistió el JWT. La evaluación local sin bearer reprodujo 503 en 475 ms con el 401 upstream correlacionado. No se usó ni se solicitó el token de Chatbot.

El primer `GET` health de Promotions arrancó el runtime normal desde cero; hubo dos lecturas de health debido a que la primera agotó el timeout de 20 s durante el cold start. No se modificó configuración de escala. El único job de ACA detectado era `azure-h5-smoke-chile`, Succeeded. No se modificaron PR #275, su rama ni su worktree; #275 se integró posteriormente en `origin/master`.

## Clasificación solicitada

| Clasificación | Estado | Evidencia/limitación |
|---|---|---|
| `ROOT_CAUSE` | **CONFIRMED** | `PUBLIC_READ_ONLY` provoca outbound sin JWT; Catalog 401 correlacionado -> Promotions 503. |
| `HANDLER_DEPLOYED` | **VERIFIED** | Handler presente en SHA `4c40b31b…`; revisión/digest identificados. |
| `CHATBOT_AUTH` | **MISMATCH / G7 UNVERIFIED** | Gateway público permite `evaluarPromociones`; OpenAPI requiere serviceBearer. Grant real G3 no verificado. |
| `PROMOTIONS_INTERNAL_AUTH` | **ROOT CAUSE** | Modo efectivo público desactiva bearer outbound; token técnico disponible y probado. |
| `CATALOG_DEPENDENCY` | **PASS AUTHENTICATED** | Sin JWT: 401; `modulo-productos`/`catalogo:leer`: 200, activo y elegible. |
| `PRICING_DEPENDENCY` | **PASS AUTHENTICATED** | Sin JWT: 401; `modulo-productos`/`precios:leer`: 200. |
| `SKU_ELIGIBILITY` | **PASS** | Activo/elegible, canal CHATBOT; identidad canónica coincide. |
| `CURRENT_PRICE` | **PASS** | 249.90 PEN; no hay oferta; vigente al instante probado. |
| `LOCAL_FIX` | **IMPLEMENTED** | Provider ahora fuerza modo outbound `AUTHENTICATED`; pruebas locales en Draft PR. |
| `LIVE_HTTP_200` | **NOT VERIFIED** | No hubo POST live ni respuesta acreditada. |

## Corrección mínima y bloqueos

Corrección implementada localmente: `integration-providers.ts` pasa `AUTHENTICATED` siempre al adaptador interno, sin depender de la política inbound. Se mantienen `promotionsServiceTokens`, el cliente autorizado `modulo-productos`, el fail-closed si falta token y no se reenvía el bearer entrante. No requiere un cliente nuevo ni cambios de grants G7.

La configuración de URLs y credencial es suficiente; no requiere cambio. El cold start fue observado y explica latencia de arranque desde cero, pero no lo cambié porque la instrucción prohíbe alterar escalas. El Gateway público sigue siendo una discrepancia de autenticación externa respecto al OpenAPI; no la modifiqué en esta corrección y requiere rollout autenticado separado con G7.

### Recursos, rollout y rollback preparados

- **Causa confirmada:** solo requiere publicar nueva imagen/revisión de `promotions-svc` con el cambio local en `integration-providers.ts`. No cambiar URLs, secrets, identidad G7 ni Pricing/Catalog.
- **Autenticación externa:** recursos `api-gateway` y `promotions-svc` (modo/allowlist) después de que G7 registre/provisione `modulo-chatbot` para `api-productos` + `promociones:evaluar`. Retirar `evaluarPromociones` de la allowlist pública al activar la ruta autenticada, en una ventana coordinada. Mantener el gate Chile cerrado y no despachar CD desde esta intervención.
- **Rollback de la corrección:** volver a la imagen anterior de Promotions manteniendo la configuración y los secretos actuales; esto restauraría el 503 de las llamadas internas en modo público. No revertir a una llamada anónima de Catalog/Pricing como mitigación. Esta intervención no despliega.
- **Rollback de escala:** si G6 aprueba una mitigación temporal tras probar cold start, guardar la escala original y restaurar los valores `min=0`, `max=1` al finalizar la ventana o ante regresión. No se modificó escala en este diagnóstico.

**Dependencias externas:** ninguna para la corrección outbound. G7 ya concede los scopes usados y se validaron live. La autenticación inbound externa G3/Gateway permanece como discrepancia separada para un rollout autenticado posterior; no bloquea esta corrección.

No se creó PR: aún no hay corrección demostrada que justifique código. No se modificaron ACA, escalas, revisiones, tráfico, ingress, secretos, Service Bus, Supabase, datos QA, RBAC ni el gate `AZURE_CHILE_DEPLOY_ENABLED`.

## Payload y mensaje técnico para Sonny

Después de que ChatGPT revise y autorice el Draft PR y su despliegue se coordine por el proceso H5, Sonny puede hacer **un** retest bilateral desde el cliente G3 ya autorizado. No compartir el JWT. Usar el correlation ID generado por ese cliente y guardar status, duración y respuesta sanitizada:

```http
POST /api/v1/promociones/evaluar
Authorization: Bearer <token de servicio G3 obtenido por su mecanismo habitual>
Content-Type: application/json
X-Correlation-Id: <UUID nuevo>
```

```json
{
  "channel_id": "CHATBOT",
  "at": "<instante UTC real del retest, ISO-8601>",
  "lines": [{ "sku": "ADI-RF3-GRI-38", "quantity": 1 }]
}
```

No incluir `customer_ref` en el primer control (es opcional); mantener el SKU confirmado. Si G3 recibe 503, conservar correlation ID, status, duración y body sanitizado; no hacer reintentos en bucle. Mensaje: “Reproducimos la causa: Promotions estaba enviando sus lecturas a Catalog/Pricing sin bearer porque su modo de entrada `PUBLIC_READ_ONLY` también desactivaba la autenticación saliente. Catalog y Pricing rechazaron esas llamadas sin JWT; con el client_credentials autorizado `modulo-productos`, las tres lecturas responden 200 y el SKU está activo/elegible con precio 249.90 PEN. Ya está implementada una corrección local que separa ambos modos y pasa sus pruebas. No compartas tu token; el retest final se hará desde tu cliente después de la revisión y despliegue autorizados.”

## Validaciones y artefactos

- Azure CLI, exec privado y lectura de env sanitizada: **PASS**, sin cambiar configuración/escala ni imprimir credenciales.
- Evaluación live local sin JWT: **503 reproducido**; Catalog log correlacionado confirma upstream 401.
- Dependencias sin JWT: Catalog contexto/producto 401, Pricing 401 caliente. Dependencias con `promotionsServiceTokens` live: todas 200.
- DTO live vs `commercial-http.ts`: **PASS**; contexto activo/elegible, variante SKU, precio/currency/vigencia correctos.
- Pruebas focalizadas: **89 PASS** en 4 archivos (`integration-providers`, `internal-http`, `commercial-http`, `service-tokens`). `npm run typecheck -- --pretty false`: **PASS**. `npx oxlint` en los dos archivos modificados: **PASS**.
- `npm ci`: **PASS**, 0 vulnerabilidades; avisos de engine porque el host usa Node 24.3.0 y el repo pide Node `^22.22.3 || >=24.15.0`. No cambió package-lock.
- `LIVE_HTTP_200`: las tres dependencias internas sí dieron 200 autenticadas; la evaluación promocional final aún no se ejecutó con Chatbot ni contra el código corregido desplegado.
- Worktree: creado desde `origin/master` SHA `daf4882b7dc6895c6601a1f4af209ec92c8215b0` y sincronizado de forma segura con el `origin/master` actualizado; no se modificaron otros worktrees ni el PR #275.
