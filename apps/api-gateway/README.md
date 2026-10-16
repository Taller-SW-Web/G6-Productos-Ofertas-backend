# Gateway HTTP — #106 y coordinación #21

Owner asignado en #106: Axel Cueva, rama `cueva`. La autorización transversal
de Marco está registrada en #21 y se limita a `apps/api-gateway`. No se cambian
otros servicios, contratos, librerías, dependencias o configuración global.

## Contrato y comportamiento

Fuente G6: Docs `c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b`, OpenAPI candidata
0.6.0-rc.1, blob `f64bfe9a097b2a0f74c2600988305443d92f640e`.
Se consultaron Arquitectura, registro/matrices DEC-F e integración. DEC-F-012
exige distinguir versión contractual, código, pruebas, grants y despliegue;
las invariantes de negocio permanecen en sus bounded contexts.

Inventario generado: **135 operaciones, 108 paths contractuales**, bajo
`/api/v1`. `src/routing/contract-routes.ts` conserva método/path, operationId,
owner, seguridad, audiencia/scope/clientes, rol/introspección, headers y códigos
de respuesta de la fuente. Los paths se enrutan al mismo path/base `/api/v1`
del servicio dueño; el Gateway no implementa comportamiento comercial.

| Prefijo                                                             | Owner           |
| ------------------------------------------------------------------- | --------------- |
| productos                                                           | catalog-svc     |
| categorias, marcas, caracteristicas, tipos-producto, taxonomia, seo | taxonomy-svc    |
| precios                                                             | pricing-svc     |
| auditoria-precios                                                   | price-audit-svc |
| promociones, cupones, recomendaciones                               | promotions-svc  |
| combos                                                              | combos-svc      |
| inventario                                                          | inventory-svc   |
| carga-masiva                                                        | bulk-svc        |

Solo se aceptan combinaciones método/path del inventario. Paths estáticos tienen
precedencia sobre parámetros; traversal, separadores codificados y métodos
ajenos no alcanzan upstreams. El destino proviene de configuración, nunca del
request. No se siguen redirects. Headers de conexión/cookies no se propagan;
correlation e idempotency siguen las declaraciones de cada operación.
Multipart/JSON se reenvían como bytes cuando se arranca desde `main.ts`.

Timeout total configurable, cancelación por desconexión, lectura de cuerpos y
respuestas acotada (10 MiB), error técnico visible. Problem Details conserva
solo código/status contractuales, título genérico y correlación; descarta
detail/stack y payload raw del proveedor. No hay logs de tokens ni credenciales.
Los destinos no configurados responden indisponibilidad; no hay mocks en runtime.

## Seguridad

G7: `cf261d55cfb53b763ef6792c3b0c6fbff4c59c07`, kit de integración,
SPEC-17 y preparación interna. Verificación RS256 nativa con claves públicas
JWKS del endpoint HTTPS configurado, issuer exacto, kid, firma, exp/nbf,
iat/jti y tipo. No se confía en claves/URLs del header entrante. Caché de claves
60 segundos compartida por proceso; errores de actualización fallan cerrado.

- Servicio: `tipo=servicio`, `sub` del cliente, audiencia de G6 y scope exacto;
  además la allowlist específica del operationId. No autoriza a Postventa a
  reservar/consumir/liberar por heredar el scope de otra operación.
- Humano: `tipo=acceso`, sub UUID, roles como lista de strings y actor
  `GESTOR_COMERCIAL` según Arquitectura §1.2.1 (o rol explícito del operationId).
  **No se exige audiencia de servicio al token humano**, según el kit G7.
- Mutaciones de Pricing con introspección: permanecen cerradas con 503 hasta
  disponer del adaptador autorizado. Un JWT válido no sustituye introspección.
- Las dos operaciones SEO con `security: []` no quedan publicadas por defecto.
  Deben figurar en una allowlist de exposición expresamente aprobada. No se
  convierte userBearer en acceso anónimo ni se distribuye token al navegador.

No se atribuyen grants, homologación ni autenticación G7 real por disponer de
este validador. Los tokens firmados y proveedores usados en pruebas son aislados.

## Configuración local

Copiar `.env.example` de esta aplicación como `apps/api-gateway/.env.local`.
Precedencia: entorno de proceso > archivo local del Gateway > `.env` raíz.
No se carga el `.env.local` de Promotions ni el administrativo de la raíz.
No se cambia package.json para cargar archivos de otra aplicación.

- `API_GATEWAY_PORT` > `PORT` > 3000.
- `GATEWAY_TIMEOUT_MS`: entero 1–60000, por defecto 5000.
- `GATEWAY_<SERVICIO>_URL`: origin HTTP/HTTPS privado, sin path, query,
  credenciales ni fragmento; el identificador usa guiones bajos y mayúsculas.
- `AUTH_ISSUER` y `AUTH_JWKS_URL`: ambos o ninguno, HTTPS acordado con G7.
  Sin configuración de confianza ninguna operación protegida se reenvía.
- `GATEWAY_PUBLIC_OPERATION_IDS`: solo operationIds contractualmente anónimos
  cuya exposición esté aprobada. Vacío por defecto.

`GET /health` sigue indicando únicamente liveness. La comprobación interna
`GatewayReadiness.check()` consulta `/health/ready` de upstreams habilitados con
timeout; cero upstreams o cualquier fallo implica not_ready. No hace fan-out en
cada request de negocio/liveness. No se crean endpoints técnicos adicionales.

## Verificación

```powershell
npm test -- apps/api-gateway --maxWorkers=1
npm run test:e2e -- apps/api-gateway --maxWorkers=1
```

Pruebas enfocadas ejecutadas: **31 unitarias / 143 HTTP, PASS**. Cubren las 135
operaciones del inventario (las cinco de introspección se acreditan como rechazo
seguro), firmas reales RS256 sintéticas, audiencia/cliente/scope/tipo/rol,
manipulación, expiración, caché, matching, forwarding a proveedor HTTP aislado,
headers, errores sanitizados, timeout, multipart, cuerpos incompletos y readiness.
El proveedor se reutiliza una vez por suite. No son E2E de negocio ni prueba G7.

Regeneración offline: descargar el OpenAPI del commit indicado, convertir YAML
a JSON con un parser YAML y ejecutar
`node apps/api-gateway/test/generate-routes.mjs <openapi.json>`; después aplicar
Prettier y ejecutar pruebas. El parser se usó como herramienta temporal, sin
añadir dependencias del proyecto. No versionar la copia YAML/JSON temporal de
`node_modules/.cache`; el inventario generado es el artefacto de runtime.

## Estado y dependencias específicas

Implementación local y pruebas aisladas: entregadas. Integración con servicios
reales, autenticación G7, homologación y despliegue: NO EJECUTADOS.

| Owner                  | Operación afectada                 | Desbloqueo verificable                                                                                                 |
| ---------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| G7 / integración G6    | Uso autenticado externo            | Issuer/JWKS, grants y credenciales efectivos por consumidor/operación, y prueba real.                                  |
| Vera / Pricing y G7    | Cinco mutaciones con introspección | Integración autorizada de introspección y pruebas contra el contrato vigente; conservar rechazo seguro hasta entonces. |
| Cada owner de upstream | Routing de negocio real            | Handler/contrato de la ruta implementado y provider probado en su servicio.                                            |
| Marco / exposición     | Rutas SEO anónimas                 | Allowlist revisada y evidencia efectiva de exposición autorizada.                                                      |
| Marco / revisión       | Continuación de #107/#108/#110     | Criterios, revisión y merge de #106 exigidos como prerrequisito.                                                       |

**#20 HTTPS:** pendiente por decisión del usuario; todavía no existe URL pública
del Gateway. No se ejecutan más comprobaciones de HTTPS ni cambios de Oracle,
DNS, firewall, proxy o despliegue. En el registro remoto Backend
`24227527c632be4f3b8de612954328904ea57de0` solo Inventory está habilitado; eso
no acredita un Gateway publicado. Retomar cuando haya endpoint/alcance autorizado.
