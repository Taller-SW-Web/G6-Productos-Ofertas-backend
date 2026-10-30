# Backend #50 — integración administrativa mediante Gateway

Owner: Gabriel Poma. Rama `poma`. SHA inicial
`293790c3380dbe7d60759c458faf1e543fc0497e`; master contrastado
`5ff2cd6b03d3dbaab1d5e8669270d23073402686`: 53 delante / 0 detrás.
PR existente [#125](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/pull/125)
abierto y mergeable al iniciar. No se sincronizó porque no había commits
pendientes de master. No se modificaron seeds locales previos ni el certificado.

## Fuentes y clasificación inicial

Docs master `599c34f4e677c8792532e2cc31ac372473a10710`: OpenAPI
0.6.0-rc.1, AsyncAPI 0.6.0-rc.3, SPEC/HU/FLOW-003/004, SPEC-009/010,
DEC-F-001/002/006/009/011/012, registro y matrices, arquitectura, errores,
kit, pruebas de contrato y acuerdos G1 y Pricing/Catalog. Seguridad main
`9c11ab505ac15b1b64cb3eb7b1dbf5d8279a1219`: OpenAPI, SPEC-17, matriz
de scopes, kit e H4. Frontend master
`5317ec3a21ef60b354ec65a184a52270cae42053`: los repositorios de dominio,
composición y hooks indicados por el encargo; `docs/ISSUE_35_CATALOGO.md`
no estuvo disponible en esa rama. Inventario de blobs/URLs en
[`test/evidence/issue-50-sources.json`](test/evidence/issue-50-sources.json).

Se leyeron AGENTS, guías Oracle, dependencias/red/AMQP/checklist,
H4-MODO-DEMO-AUTH-REVERSIBLE, #144, paquete G1 y auditorías #47–#49.
No se aplicaron migraciones ni se contactó Oracle/Supabase/broker compartido.

Las 18 operaciones ya tenían controller y caso de uso. Alcance interno:
`IMPLEMENTAR_AHORA` para discrepancias verificadas de validación y seguridad;
`IMPLEMENTAR_PARCIAL` para prueba completa con dependencias externas.
Escrituras demo sin identidad técnica aprobada y perímetro acreditado:
`BLOQUEADO_ESPECÍFICO`, sin ampliar flags/bypass ni inventar actores.

## Correcciones implementadas

- Listado, detalle por ID y slug admiten canal omitido para usuario verificado.
  No se asigna MARKETPLACE por defecto. Servicios de canal y lecturas demo
  mantienen la exigencia de canal. Se reprodujo el defecto con tres pruebas
  HTTP fallando por 400 antes del cambio; las 54 pruebas de esa suite pasan.
- Los tres GET exigen `GESTOR_COMERCIAL` a humanos, igual que Gateway y la
  arquitectura §1.2.1. Se conservan scopes y allowlists de servicio.
- Audiencia de servicio incorrecta devuelve `401 TOKEN_INVALIDO`, conforme
  SPEC-17/kit G7. Scope/cliente/rol insuficiente conserva 403. No se exige
  audiencia inventada a JWT de usuario ni se reemplaza el verificador existente.
- Filtro monetario global omite canal hacia Pricing y solo admite resultados
  globales. SKU con coma usa el GET individual publicado, codificado como path;
  el resto conserva lotes de hasta 100, concurrencia acotada y un único `at`.
  El presupuesto conjunto de token/HTTP es 5 s, conforme SPEC-003 §7.
  Fallo técnico sigue siendo 503 completo, sin página parcial ni fallback.

## Matriz de las 18 operaciones

`HTTP`: suite catalog-http con fixtures de casos de uso, no PostgreSQL.
`G-auth`: Gateway real en proceso separado y Catalog real, guard/verificador
RS256/discovery/JWKS reales con claves de fixture; DB explícitamente no disponible.
`PG-50`: caso HTTP-50 del runner PostgreSQL/TLS desechable existente: Gateway y
Catalog reales, persistencia real, Taxonomy y resultados Pricing/Inventory de
fixture. Su ejecución local se omite por Docker ausente; requiere CI.

| operationId | Implementado | Test HTTP | Test Gateway | Estado local |
|---|---|---|---|---|
| listarProductos | sí | PASS | G-auth PASS; PG-50 preparado | parcial, contexto global corregido |
| obtenerProducto | sí | PASS | G-auth PASS; PG-50 preparado | parcial |
| obtenerProductoPorSlug | sí | PASS | G-auth PASS; PG-50 preparado | parcial |
| crearProducto | sí | PASS | G-auth/DTO PASS; PG-50 preparado | parcial |
| actualizarProducto | sí | PASS | G-auth/409 PASS; PG-50 preparado | parcial |
| activarProducto | sí | PASS | G-auth PASS; PG-50 preparado | parcial |
| desactivarProducto | sí | PASS | G-auth PASS; PG-50 preparado | parcial |
| reactivarProducto | sí | PASS | G-auth PASS; PG-50 preparado | parcial |
| obtenerPreparacionProducto | sí | PASS | G-auth PASS; PG-50 preparado | parcial |
| reintentarPreparacionProducto | sí | PASS, 202 | G-auth PASS; PG-50 202/409 preparado | parcial |
| listarVariantesProducto | sí | PASS | G-auth PASS; reproducción 400→503 | bloqueo específico Gateway |
| obtenerVariante | sí | PASS | G-auth PASS; reproducción 400→503 | bloqueo específico Gateway |
| crearVariante | sí | PASS | G-auth/SKU inválido PASS; PG-50 preparado | parcial |
| actualizarVariante | sí | PASS | G-auth/409 PASS; PG-50 preparado | parcial |
| activarVariante | sí | PASS | G-auth PASS; PG-50 preparado | parcial |
| desactivarVariante | sí | PASS | G-auth PASS; PG-50 preparado | parcial |
| reactivarVariante | sí | PASS | G-auth PASS; PG-50 preparado | parcial |
| reintentarPreparacionVariante | sí | PASS, 202 fixture | G-auth PASS; PG-50 409 preparado | parcial |

PG-50 cubre altas, SKU y combinación duplicados, versión correcta/obsoleta,
activación incompleta, preparación persistida, retry admitido/repetido,
resultados causales de fixture aplicados por CatalogMessageService real,
lecturas positivas/404, paginación/filtros, variantes, última variante activa,
reactivación y rollback ante Taxonomy 503. Los fixtures de resultados no
acreditan envío AMQP ni respuesta de Vera/Taco reales. El timestamp de publicación
usado para retry es setup explícito de la base desechable, sin broker.

## Defectos externos reproducidos para Marco

| Método/ruta bajo /api/v1 | operationId | Catalog / esperado OpenAPI | Gateway observado | Origen |
|---|---|---|---|---|
| GET /productos/{productoId}/variantes?pagina=1&pagina=2 | listarVariantesProducto | 400 VALIDACION | 503 SERVICIO_NO_DISPONIBLE | apps/api-gateway/src/routing/contract-routes.ts, entrada listarVariantesProducto |
| GET /productos/{productoId}/variantes/not-a-uuid | obtenerVariante | 400 VALIDACION | 503 SERVICIO_NO_DISPONIBLE | mismo archivo, entrada obtenerVariante |

Reproducción: `npm run test:e2e -- --maxWorkers=2
apps/catalog-svc/test/gateway-catalog.authenticated.e2e-spec.ts`, casos
`records the Gateway route defect`. La prueba verifica directamente 400 y
después 503 por Gateway. Su PASS demuestra el defecto externo; no significa
que Gateway cumpla ese contrato. Marco debe alinear las dos entradas generadas
con OpenAPI vigente y verificar que la respuesta final preserve 400/VALIDACION.
No se modificó Gateway ni el generador/contrato.

## Validación local y límites

Windows, Node 24.16.0/npm 11.13.0. TEMP/TMP apuntan a un directorio local
escribible; pruebas HTTP ejecutadas con permiso de loopback. No se cargan
archivos runtime privados. El harness configura explícitamente demo=false;
cuando no recibe PostgreSQL desechable usa un puerto de persistencia
explícitamente indisponible, sin recurrir a PG* del ambiente.

| Comando | Resultado ejecutado |
|---|---|
| npm ci --no-audit --no-fund | PASS, 378 paquetes; sin cambio del lock |
| npm test -- --maxWorkers=2 apps/catalog-svc | PASS, 431 pruebas |
| npm run test:e2e -- --maxWorkers=2 apps/catalog-svc | PASS, 145; 48 SKIP |
| npm test -- --maxWorkers=2 | PASS final, 1520; 38 SKIP |
| npm run test:e2e -- --maxWorkers=2 | PASS final, 868; 138 SKIP |
| E2E Gateway autenticado + contexto SKU después del ajuste final | PASS, 48 pruebas |
| npm run typecheck; npm run lint; npm run build:catalog-svc | PASS |
| npm run format:check | PASS tras reparar formato del test nuevo |
| tsc explícito sobre E2E nuevos/modificados y helpers | PASS tras anotar retorno de una factory de JWT |
| git diff --check | PASS |
| PostgreSQL/RabbitMQ/Docker local | NO EJECUTADO: Docker no instalado; suites SKIP |
| JWT emitido realmente por G7 / navegador React / Oracle | NO EJECUTADO |

Primer intento HTTP en sandbox: EACCES a loopback; repetición autorizada permitió
reproducir los tres 400 reales. Primera corrida del harness detectó el 400→503
externo y un cierre de proceso Windows no acotado; ambos quedaron tratados
explícitamente. La expectativa antigua de audiencia 403 se actualizó a 401
en dos suites. No se eliminaron pruebas ni se relajó el contrato para pasar.
CI del nuevo SHA se informa por separado al entregar; la CI inicial
[40974219664](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/40974219664)
pertenece exclusivamente a `293790c…`, no prueba estos cambios.

## Consumidor React y fronteras pendientes

El frontend consultado publica puertos de dominio, con nombres camelCase,
perfil plano y modelos de preparación propios. `createCatalogServices(api)`
requiere adaptadores HTTP inyectados o falla explícitamente; no prueba que
exista una interacción UI/API. Marco/owner frontend debe implementar/integrar
esos adaptadores con el cliente común: mapear `product_id/variant_id`, SKU,
`pagina/tamanio/total`, `PaginaVariantes.meta`, atributos `caracteristica_id`
y `valor_id`, perfil físico contractual anidado, estados y errores por `code`.
El listado/detalle comercial no promete flags administrativos ni un GET nuevo
para borradores: el consumidor no debe asumirlos ni fabricar preparación.
En concreto, los GET de producto usan `ProductoResumenComercial`/
`ProductoDetalleComercial`, sin `status`, `catalog_version` ni perfil físico
administrativo; el detalle filtra productos no activos. `estado=BORRADOR` en
el listado autorizado no convierte su proyección en `ProductoDetalle`.
La UI pide esos datos para editar y versionar un borrador: existe una frontera
contractual pendiente que un simple mapeo camelCase no resuelve. Marco/owner
de contratos debe definir y aprobar cómo se obtiene esa vista administrativa
sin ampliar unilateralmente la lectura comercial. No se creó otra ruta ni se
insertaron flags administrativos en respuestas comerciales.
Consultar `obtenerPreparacionProducto` para `manual_retry_allowed`; 202 solo
significa admisión. SKU de variante sigue obligatorio aunque el puerto de
dominio frontend lo modele opcional; no se adapta backend a ese error.

| Dependencia / estado | Owner | Operación afectada | Condición verificable de desbloqueo |
|---|---|---|---|
| Gateway / BLOQUEADO_ESPECÍFICO | Marco | errores 400 de los dos GET de variantes | tabla de rutas actualizada y regresión final 400/VALIDACION |
| UI/API / pendiente | Marco + owner frontend | 18 interacciones administrativas | adaptadores reales, error visible sin fallback, prueba navegador por SHA frontend/backend |
| Vista administrativa / BLOQUEADO_ESPECÍFICO | Marco/arquitectura + owner de contratos y frontend | cargar/editar productos borrador y recuperar versión/perfil | contrato aprobado para la vista requerida por el backoffice; no asumir que el GET comercial la entrega |
| Taxonomy / pendiente integración | López | referencias de categoría/marca/tipo, esquema/atributos | GET administrativos reales compatibles, IDs/esquemas/versiones autoritativos y prueba conjunta con JWT humano |
| Auth G7 / pendiente | G7 (provisión) + Marco | operaciones administrativas y llamadas técnicas | usuario Gestor real, issuer/JWKS y credenciales/grants efectivos; positivos/401/403 por SHA |
| Preparación / pendiente integración | Vera + Taco + Marco/Poma | activación y retry | resultados reales causales, replay idempotente, red/ACL/recuperación AMQP homologados |
| Demo escrituras / BLOQUEADO_ESPECÍFICO | Marco/infra + owners | mutaciones sin JWT y validación Taxonomy | operaciones aprobadas, contexto técnico no humano trazable y aislamiento verificable; luego adaptación revisada |
| Oracle / no solicitado | Marco/infra | despliegue del candidato | autorización individual y gates por SHA/digest; no desplegado aquí |

H4 D-01/D-02 se cubren con rechazo y fixtures criptográficos; D-03 real sigue
PENDIENTE_G7; D-04/D-06 de escrituras requieren identidad/perímetro aprobados;
D-05/D-07/D-08/D-09/D-10 conservan suites read-demo/config/guards existentes.
No se atribuye una prueba de perímetro externo a loopback ni D-10 real a fixtures.

## Veredicto y continuación

`BACKEND_PARTIALLY_READY` / `PARTIAL`. Correcciones internas implementadas y
regresión local aprobada; persistencia completa de HTTP-50 pendiente de ejecución
en CI al redactar este informe y dos errores Gateway pendientes de Marco.
No se declara ISSUE_CLOSED, INTEGRATION_VERIFIED ni READY_FOR_DEPLOY.

Para cerrar #50 faltan los errores finales de Gateway y una interacción React
real, con SHA de ambos repositorios y fallo visible sin fallback. La integración
autenticada externa, homologación y despliegue conservan evidencia independiente.
Se deja para #51 el mecanismo demo de escrituras sujeto a aprobación de actor/
perímetro, la configuración operativa y smoke/deploy H4; este bloque no lo
implementa ni desbloquea AMQP compartido.
