# Entrega interna de Pricing para auditoría

Rama `vera`, base `8dbb44b`, 2026-10-17. Owner: Leonardo Vera.
Alcance confirmado por el solicitante: trabajar lo interno; las definiciones
normativas pendientes corresponden a auditoría. Estado global: **PARTIAL**.

## Trazabilidad de los ocho issues abiertos

| Issue | Estado operativo y avance comprobable | Pendiente de cierre |
|---|---|---|
| [#13 DATA-003](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/13) | `IMPLEMENTAR_PARCIAL`: nueve checks existentes de hashes, referencias, importes, vigencias y herencia aprobados. No se propone nueva carga. | Reauditar publicación tras #12. La evidencia versionada anterior contiene borradores; no prueba el estado runtime actual. |
| [#24 SKU/canal](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/24) | `BLOQUEADO_ESPECÍFICO` para exposición comercial; resolver puro existente conservado. | Contexto autoritativo de Catálogo por SKU para producto/variante, estado y elegibilidad; no sustituirlo con SQL ajeno. |
| [#55 HTTP](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/55) | `IMPLEMENTAR_PARCIAL`: cuatro operationIds administrativos reales con JWT/JWKS, rol, paginación, errores y PostgreSQL. | `consultarPrecios`/`obtenerPrecioSku`: frontera de Catálogo. Prevalidación/reporte: P-PRI-01. |
| [#56 escrituras](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/56) | `IMPLEMENTAR_PARCIAL`: `PricingMutations.update/schedule` conecta dominio, locks/CAS, snapshots, programación y Outbox en una transacción. | Adaptadores HTTP, inicialización de nuevos overrides, payload aprobado, introspección e importación. |
| [#57 RabbitMQ](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/57) | `IMPLEMENTAR_PARCIAL`: persistencia atómica interna del hecho; no relay/consumer productivo nuevo. | P-PRI-02 y transporte AMQP autorizado. Inicialización tipada también exige producir el hecho de cambio. |
| [#58 robustez](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/58) | `IMPLEMENTAR_PARCIAL`: timeouts, JWKS acotado/cache con expiración, Problem sanitizado, correlación/duración/estado y readiness. | Fallos/reconexión/replay de broker al incorporar #57; retry/DLX productivo no acreditado. |
| [#59 React](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/59) | `IMPLEMENTAR_PARCIAL`: provider de las cuatro operaciones preparado y probado. | Feature `src/features/pricing` del frontend, cliente/config compartidos #109/Frontend #45 y stack coordinado. |
| [#60 E2E](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/60) | `IMPLEMENTAR_PARCIAL`: HTTP→PostgreSQL y casos de uso→PostgreSQL/Outbox reales con identidad firmada de prueba. | Recorrido React→Gateway→Pricing, RabbitMQ e identidad compartida. El nombre E2E del runner no acredita ese recorrido. |

No se usa `Closes` para estos issues. Ningún estado de integración, homologación
o despliegue se deduce de implementación interna ni de estas pruebas locales.

## Provider disponible

| Método y ruta | operationId OpenAPI |
|---|---|
| `GET /api/v1/precios/productos/{productoId}` | `obtenerPrecioBaseProducto` |
| `GET /api/v1/precios/productos/{productoId}/programaciones` | `listarProgramacionesPrecioProducto` |
| `GET /api/v1/precios/skus/{sku}/programaciones` | `listarProgramacionesPrecioSku` |
| `GET /api/v1/precios/importaciones/{batchId}` | `obtenerImportacionPrecios` |

El prefijo coincide con `originalUrl` reenviado por Gateway. Son operaciones
administrativas `userBearer`; exigen RS256, issuer configurado, clave RSA de
2048 bits mínimo, `tipo=acceso`, `sub` UUID, `iat/exp/nbf`, `jti` y rol
`GESTOR_COMERCIAL`. Sin token: 401; rol insuficiente: 403; JWKS/config ausente
o no disponible: 503. Sin configuración de identidad, readiness devuelve 503.
No hay bypass de demo ni confianza en headers de identidad.

Ambas URLs de identidad se configuran juntas con HTTPS, sin credenciales,
fragmentos ni redirects. Solo `NODE_ENV=test` admite HTTP loopback para JWKS
aislado. Fetch: 2 segundos, 1 MiB, 100 claves y cache de 60 segundos. El cache
vencido no se reutiliza si falla la renovación. No acredita identidad real G7.

Consultas `REPEATABLE READ READ ONLY`; paginación base uno, default 1/20, máximo
200, orden estable por inicio/ID. Precio base: vigencia global actual y versión
de definición para CAS; programación: versión de su snapshot. Programar no
adelanta el precio vigente. Una versión bigint no representable exactamente
en JSON se rechaza sin redondeo. El lote omite `row_input`, actor, URI privada
y detalle libre; limita los códigos por fila a los normativos aplicables.

DB/permisos/timeouts producen 503, sin simular precio ausente ni filtrar SQL o
credenciales. Correlación UUID generada/conservada; valor inválido devuelve
VALIDACION con ID nuevo. Logs HTTP: servicio, entorno, UUID, status y duración,
sin JWT, URL con IDs, body ni error original. Readiness verifica SELECT en las
seis tablas propias usadas por estos casos de uso; no hace fan-out a G7/broker.

## Escritura interna

`PricingMutations` está registrado/exportado. Opera sobre una definición ya
existente de producto o SKU/canal; no crea contexto ni overrides. `update`
compara versión; `schedule` asigna la siguiente bajo lock sin versión cliente.
Ambos confirman versión, cierres históricos, snapshot nuevo, programación
cuando aplica y Outbox juntos. El dominio recibe campos de negocio sin PK/FK
para evitar reutilizar la identidad del snapshot anterior. Un fallo de Outbox
revierte el cambio; rechazo de negocio no persiste hechos. No publica en el tx.

El caller debe suministrar el payload opaco obligatorio de `PriceFact`, sin
valor por defecto. El adaptador que lo construya espera P-PRI-02. Los `{}` de
tests son fixtures de atomicidad; no son un payload productivo acordado.
Outbox persistido no demuestra publicación, ACK, consumer ni homologación.

## Dependencias específicas

| Owner responsable | Operación afectada | Condición verificable de desbloqueo |
|---|---|---|
| Leonardo Vera + Marco/arquitectura y consumidores concernidos | Cambio/aplicación masiva | Definición normativa verificable del data/payload P-PRI-02 y aceptación concernida cuando corresponda. No completar `GenericData` por inferencia. |
| Leonardo Vera + Marco/arquitectura | Archivo, prevalidación, admisión y reporte | Formato/cabeceras/versionado y política de prevalidación/reporte publicados (P-PRI-01). |
| Gabriel Poma/Catálogo + Marco/arquitectura | Herencia, estado y elegibilidad por SKU | Contrato ejecutable que entregue contexto autoritativo por SKU; búsqueda comercial por texto no garantiza ese lookup. |
| Gabriel Poma / #12 | DATA-003 | Publicación, IDs/versiones y elegibilidad confirmados; reauditar matriz existente. |
| Marco Castilla / Gateway #107/#109 | Mutaciones autenticadas y demo | Introspección conectada y frontera privada acordada. Gateway actual rechaza introspección pendiente; modo demo elimina Authorization y no autentica este provider. |
| Leonardo Vera / Frontend #38 + Marco / Frontend #45 | #59/#60 | Adaptadores de feature, cliente compartido y stack real coordinados. |
| Marco/infraestructura + Leonardo Vera | Transporte #57 | Cliente AMQP autorizado en el monorepo y broker/topología de pruebas. No hay cliente AMQP instalado; dependencias globales exigen autorización expresa del issue. |

## Normativa y evidencia

Fuentes oficiales remotas: `Taller-SW-Web/G6-Productos-Ofertas-docs`, master
`c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b`: Arquitectura §§7/9/10/16/21/24–26,
SPEC/HU/FLOW-013, modelo físico §23, registro DEC-F, matriz de trazabilidad y
matriz intermodular. OpenAPI `0.6.0-rc.1`, AsyncAPI `0.6.0-rc.2` candidatos.
Aplican DEC-F-001/006/009/012. No se modifican contratos ni migraciones.

Node 24.19.0, Vitest 4.1.11, PostgreSQL 16.15 real en Docker aislado existente,
una instancia por suite, rol runtime sin ownership. JWKS HTTP de prueba y
firmas RSA reales. Sin credenciales ni escrituras compartidas.

```powershell
npm test -- apps/pricing-svc
$env:PRICING_TEST_POSTGRES = '1'
npm run test:e2e -- apps/pricing-svc
node --test scripts/seed/mcp/pricing/verify.test.mjs
npm test
npm run test:e2e
npm run typecheck
npm run lint
npm run format:check
npm run build:pricing-svc
git diff --check
```

Resultados locales finales (Node 24.19.0):

| Comando | Resultado |
|---|---|
| `npm test -- apps/pricing-svc` | PASS: 154 pruebas |
| `PRICING_TEST_POSTGRES=1 npm run test:e2e -- apps/pricing-svc` | PASS: 25 pruebas, cero omitidas |
| `node --test scripts/seed/mcp/pricing/verify.test.mjs` | PASS: 9 checks |
| `npm test` | PASS: 279 pruebas |
| `PRICING_TEST_POSTGRES=1 npm run test:e2e` | PASS: 359 aprobadas, 13 omitidas preexistentes de otras suites por entorno |
| `npm run typecheck` | PASS |
| TypeScript estricto de todo Pricing y sus pruebas | PASS |
| `npm run lint` | PASS |
| `npm run format:check` | PASS |
| `npm run build:pricing-svc` | PASS |
| `git diff --check` | PASS |

El PR registra el SHA de entrega. Además se ejecuta
TypeScript estricto sobre todos los `.ts` de Pricing, incluidos tests, mediante
`tsc --ignoreConfig --noEmit` y opciones NodeNext/decoradores del monorepo.

Fallos detectados y corregidos durante la validación: reutilización de PK al
pasar una fila ORM completa al dominio, tipos de mocks e import ESM de test.
Se conservan las pruebas; las ejecuciones fallidas no se reportan como PASS.

Implementación interna: parcial comprobada. Integración autenticada compartida,
homologación externa y despliegue: no ejecutados/acreditados en esta entrega.
