# Gateway HTTP — #106 y coordinación #21

Owner asignado en #106: Axel Cueva, rama `cueva`. La autorización transversal
de Marco está registrada en #21 y se limita a `apps/api-gateway`. No se cambian
otros servicios, contratos, librerías, dependencias o configuración global.
Esa delimitación corresponde al bloque Gateway. Por autorización posterior del
usuario, el PR #116 incorpora también los commits propios de #70/#33/#15/#112;
la ampliación, las dos dependencias autorizadas de #33 y sus evidencias se
registran por separado en la descripción del PR y los documentos de Promotions.

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

Timeout total configurable y cancelación por desconexión. El presupuesto técnico
de memoria de 10 MiB se aplica a JSON y errores bufferizados. Los tres imports
multipart, los dos multipart de marcas y las respuestas de archivos se transmiten
con backpressure, sin
aplicar ese presupuesto como límite del archivo. OpenAPI, SPEC-001 y SPEC-013
consultadas no fijan un máximo numérico de bytes para esos imports. El owner del
import aplica su límite y el Gateway conserva `413 ARCHIVO_EXCEDE_LIMITE`, incluso
si el proveedor rechaza antes de terminar la subida. No se inventa un máximo
contractual a partir del prototipo.

`crearMarca` y `actualizarMarca` transmiten sus logos y framing multipart por el
mismo flujo. SPEC-011 fija un máximo de **5 MB** para el logo; Taxonomía aplica
esa validación de archivo. El Gateway no lo sustituye por el presupuesto JSON,
no acepta códigos de importación como errores de logo y conserva
`413 LOGO_EXCEDE_LIMITE`. Ante rechazo temprano lee primero el problema del
proveedor y descarta el cuerpo entrante restante sin bufferizarlo antes de
terminar la respuesta, dentro del timeout ya existente; así evita perder el
413 por cierre de conexión mientras el cliente sigue subiendo.

Los errores locales de validación (400), identidad (401), autorización (403) e
indisponibilidad (503) conservan sus códigos técnicos conocidos aunque la
operación no enumere esa respuesta. Los errores del proveedor siguen sujetos a
los pares status/código declarados por operación. Problem Details usa título
genérico y correlación; descarta detail/stack y payload raw del proveedor. No hay
logs de tokens ni credenciales. No se modifica el OpenAPI.
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

H-04 queda diferido y no bloqueante para este PR, por aclaración expresa del
usuario: la validación temporal adicional de `iat` futuro se abordará en #107
cuando G7/Seguridad y la coordinación G6 acuerden la tolerancia de reloj.
No se inventa una tolerancia ni se activa integración G7 ahora. Se mantienen
la validación JWT actual, los guards y el rechazo de operaciones protegidas
sin identidad o permisos válidos; diferir esa mejora no habilita anonimato.

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

## Liveness y readiness de despliegue

`GET /health` conserva el liveness del Gateway y el puerto por defecto 3000.
El healthcheck preparado para ejecución dentro del contenedor es:

```sh
node dist/apps/api-gateway/readiness.js
```

Comprueba `/health` del propio proceso por loopback y ejecuta
`GatewayReadiness.check()`. Devuelve JSON sanitizado y código de salida 0 solo
si el proceso está vivo y todas las dependencias habilitadas están listas; en
cualquier otro caso sale con 1. No abre listeners ni endpoints adicionales.
Su incorporación al despliegue corresponde al owner de infraestructura; este
PR no modifica Compose, Caddy, Oracle ni CD.

Cada origin habilitado necesita `GATEWAY_<SERVICIO>_READINESS_PATH`, una ruta
local previamente verificada por su owner. La sonda exige HTTP 200, JSON y
`status: "ready"`; ese acuerdo técnico y su implementación deben acreditarse
antes de configurar la ruta. No se presume que exista `/health/ready` ni se
acepta el liveness `/health` o `/health/live` como readiness. Los controladores
de los ocho servicios revisados en Backend
`24227527c632be4f3b8de612954328904ea57de0` solo acreditan `/health`.

Sin ruta verificada, una dependencia habilitada queda `unverified` y el
healthcheck falla. Un timeout, respuesta inválida, redirect o dependencia caída
produce `not_ready`. Sin origins configurados también falla. Los servicios sin
origin se informan como `not_configured`; `coverage: "partial"` identifica el
despliegue progresivo, aunque los servicios habilitados estén listos. Un resultado
`ready` parcial no acredita disponibilidad de las 135 operaciones, grants,
introspección ni integración real. La sonda no se ejecuta por request de negocio
o liveness.

## Verificación

```powershell
npm test -- apps/api-gateway --maxWorkers=1
npm run test:e2e -- apps/api-gateway --maxWorkers=1
node apps/api-gateway/test/readiness.smoke.mjs # requiere build previo
```

Pruebas enfocadas ejecutadas: **57 unitarias / 299 HTTP, PASS**. Cubren las 135
operaciones del inventario (las cinco de introspección se acreditan como rechazo
seguro), firmas reales RS256 sintéticas, audiencia/cliente/scope/tipo/rol,
manipulación, expiración, caché, matching, forwarding a proveedor HTTP aislado,
headers, errores sanitizados, timeout, multipart y reportes mayores de 10 MiB,
rechazo 413 temprano, cuerpos incompletos y readiness. Las 133 operaciones
protegidas también rechazan identidad ausente y roles insuficientes antes de
contactar upstreams. El smoke ejecuta el healthcheck compilado con liveness y
dependencias disponibles, ausentes, inválidas, lentas y configuración parcial.
El proveedor se reutiliza una vez por suite. No son E2E de negocio ni prueba G7.
Las diez regresiones adicionales de marcas cubren ambos métodos, transporte
del logo de 2 MiB por encima del presupuesto JSON de prueba (1 MiB) y por debajo
de los 5 MB de SPEC-011, rechazo 413 de 11 MiB normal/temprano, código ajeno
rechazado y 401/403 antes de contactar al proveedor. Son fixtures sintéticos
de transporte, sin acreditar validación de imágenes ni integración Taxonomía.

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
| Cada owner de upstream | Readiness de dependencias          | Acreditar ruta y respuesta técnica de readiness real, distintas del liveness, antes de configurar la sonda.            |
| Infraestructura G6     | Healthcheck de despliegue          | Adoptar el comando compilado y configurar las rutas verificadas para los servicios habilitados.                        |
| Marco / exposición     | Rutas SEO anónimas                 | Allowlist revisada y evidencia efectiva de exposición autorizada.                                                      |
| Marco / revisión       | Continuación de #107/#108/#110     | Criterios, revisión y merge de #106 exigidos como prerrequisito.                                                       |

HTTPS operativo en `https://g6-productos-ofertas.duckdns.org` según la
coordinación recibida. Este PR no verifica ese despliegue ni cambia Oracle,
DNS, firewall, Caddy o CD. Tampoco implementa RabbitMQ (#108), la demo anónima
(#107) ni upstreams reales. Las pruebas con proveedores aislados acreditan el
código del Gateway; no acreditan integración autenticada, homologación externa
o despliegue.
