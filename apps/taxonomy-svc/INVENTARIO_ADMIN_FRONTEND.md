# Taxonomy: inventario administrativo para integración frontend

Corte de código Backend: `95f43e4e826e03679694a95ce6036677c8011f9e` (master). Contrato oficial Docs: `aba8d1ca998cfcd2db1c4fa87654036a5a4c1ac1`, OpenAPI `0.6.0-rc.3`. La copia Docs local revisada inicialmente indicaba rc.1; no usarla como evidencia del contrato actual.

La tabla transcribe el contrato: la presencia de ruta en los controladores no demuestra DTO completo, pruebas por operación, grants G7, despliegue Azure ni integración Vercel. Se observaron decoradores de ruta para estas operaciones en `taxonomy.controller.ts`, `taxonomy-admin-query.controller.ts`, `taxonomy-write.controller.ts` y `taxonomy-masters.controller.ts`. Confirmar respuestas y reglas en OpenAPI y ejecutar pruebas antes de habilitar cada interacción.

Las rutas se muestran con `/api/v1` para Gateway. `X-Correlation-Id` es una cabecera; los IDs entre llaves son parámetros de ruta y los filtros/paginación son query. La columna de cuerpo indica solo el tipo de contenido: consultar los esquemas OpenAPI para campos, obligatoriedad y errores. `OperationAccepted` acredita admisión, no conclusión de la baja.

| Método y ruta | operationId | Parámetros | Cuerpo | Respuesta exitosa contractual | Seguridad contractual |
|---|---|---|---|---|---|
| GET `/api/v1/categorias` | `listarCategorias` | `X-Correlation-Id` | — | 200 `{categories: Categoria[]}` | serviceBearer |
| POST `/api/v1/categorias` | `crearCategoria` | `X-Correlation-Id` | application/json | 201 `CategoriaAdmin + slug` | userBearer |
| GET `/api/v1/marcas` | `listarMarcas` | `X-Correlation-Id` | — | 200 `{brands: Marca[]}` | serviceBearer |
| POST `/api/v1/marcas` | `crearMarca` | `X-Correlation-Id` | multipart/form-data | 201 `MarcaAdmin` | userBearer |
| GET `/api/v1/categorias/arbol` | `obtenerArbolCategoriasAdmin` | `X-Correlation-Id` | — | 200 `array<CategoriaTreeNode>` | userBearer / serviceBearer |
| GET `/api/v1/categorias/{categoriaId}` | `obtenerCategoriaAdmin` | `categoriaId`, `X-Correlation-Id` | — | 200 `CategoriaAdmin` | userBearer / serviceBearer |
| PATCH `/api/v1/categorias/{categoriaId}` | `actualizarCategoria` | `categoriaId`, `X-Correlation-Id` | application/json | 200 `CategoriaAdmin` | userBearer |
| POST `/api/v1/categorias/{categoriaId}/desactivar` | `solicitarDesactivacionCategoria` | `categoriaId`, `X-Correlation-Id` | — | 202 `OperationAccepted` | userBearer |
| POST `/api/v1/categorias/{categoriaId}/reactivar` | `reactivarCategoria` | `categoriaId`, `X-Correlation-Id` | — | 200 `CategoriaAdmin` | userBearer |
| GET `/api/v1/caracteristicas` | `listarCaracteristicas` | `pagina`, `tamanio`, `estado`, `tipo`, `X-Correlation-Id` | — | 200 `PaginaCaracteristicas` | userBearer |
| POST `/api/v1/caracteristicas` | `crearCaracteristica` | `X-Correlation-Id` | application/json | 201 `CaracteristicaAdmin` | userBearer |
| GET `/api/v1/caracteristicas/{caracteristicaId}` | `obtenerCaracteristica` | `caracteristicaId`, `X-Correlation-Id` | — | 200 `CaracteristicaAdmin` | userBearer |
| PATCH `/api/v1/caracteristicas/{caracteristicaId}` | `actualizarCaracteristica` | `caracteristicaId`, `X-Correlation-Id` | application/json | 200 `CaracteristicaAdmin` | userBearer |
| GET `/api/v1/caracteristicas/{caracteristicaId}/valores` | `listarValoresCaracteristica` | `caracteristicaId`, `estado`, `X-Correlation-Id` | — | 200 `array<ValorCaracteristica>` | userBearer |
| POST `/api/v1/caracteristicas/{caracteristicaId}/valores` | `crearValorCaracteristica` | `caracteristicaId`, `X-Correlation-Id` | application/json | 201 `ValorCaracteristica` | userBearer |
| PATCH `/api/v1/caracteristicas/{caracteristicaId}/valores/{valorId}` | `actualizarValorCaracteristica` | `caracteristicaId`, `valorId`, `X-Correlation-Id` | application/json | 200 `ValorCaracteristica` | userBearer |
| POST `/api/v1/caracteristicas/{caracteristicaId}/valores/{valorId}/desactivar` | `solicitarDesactivacionValorCaracteristica` | `caracteristicaId`, `valorId`, `X-Correlation-Id` | — | 202 `OperationAccepted` | userBearer |
| POST `/api/v1/caracteristicas/{caracteristicaId}/valores/{valorId}/reactivar` | `reactivarValorCaracteristica` | `caracteristicaId`, `valorId`, `X-Correlation-Id` | — | 200 `ValorCaracteristica` | userBearer |
| POST `/api/v1/caracteristicas/{caracteristicaId}/desactivar` | `desactivarCaracteristica` | `caracteristicaId`, `X-Correlation-Id` | — | 200 `CaracteristicaAdmin` | userBearer |
| POST `/api/v1/caracteristicas/{caracteristicaId}/reactivar` | `reactivarCaracteristica` | `caracteristicaId`, `X-Correlation-Id` | — | 200 `CaracteristicaAdmin` | userBearer |
| GET `/api/v1/marcas/{marcaId}` | `obtenerMarcaAdmin` | `marcaId`, `X-Correlation-Id` | — | 200 `MarcaAdmin` | userBearer / serviceBearer |
| PATCH `/api/v1/marcas/{marcaId}` | `actualizarMarca` | `marcaId`, `X-Correlation-Id` | multipart/form-data | 200 `MarcaAdmin` | userBearer |
| POST `/api/v1/marcas/{marcaId}/desactivar` | `solicitarDesactivacionMarca` | `marcaId`, `X-Correlation-Id` | — | 202 `OperationAccepted` | userBearer |
| POST `/api/v1/marcas/{marcaId}/reactivar` | `reactivarMarca` | `marcaId`, `X-Correlation-Id` | — | 200 `MarcaAdmin` | userBearer |
| GET `/api/v1/categorias/administracion` | `listarCategoriasAdmin` | `categoriaPadreId`, `pagina`, `tamanio`, `estado`, `X-Correlation-Id` | — | 200 `PaginaCategoriasAdmin` | userBearer / serviceBearer |
| GET `/api/v1/marcas/administracion` | `listarMarcasAdmin` | `q`, `pagina`, `tamanio`, `estado`, `X-Correlation-Id` | — | 200 `PaginaMarcasAdmin` | userBearer / serviceBearer |

## Seguridad y fronteras

OpenAPI distingue `userBearer` y `serviceBearer`. En el código del corte, el verificador valida firma RS256, issuer, vigencia, `jti` y tipo del JWT. Para usuarios (`tipo=acceso`) exige `sub` UUID y `roles` como arreglo; **no comprueba audiencia en el token humano**. La PR #216 describe este perfil humano sin audiencia obligatoria: no debe atribuirse unilateralmente el requisito `api-productos` al usuario. Para servicios (`tipo=servicio`) sí se comprueban audiencia `api-productos`, scope y cliente por operación.

| Operación o grupo | Comportamiento observado en Taxonomy, modo autenticado |
|---|---|
| `listarCategorias`, `listarMarcas` | `TaxonomyAuthGuard`: servicio, `aud=api-productos`, `catalogo:leer`, `sub` en `modulo-marketplace`, `modulo-chatbot`, `modulo-retail` o `modulo-productos`; un usuario humano no satisface este guard. |
| Árbol, listados administrativos y detalle de categorías/marcas | `TaxonomyUserGuard`: humano con `GESTOR_COMERCIAL`; o servicio `modulo-productos` con audiencia `api-productos` y scope `catalogo:leer` en los métodos marcados con `AllowTaxonomyServiceRead`. |
| Escrituras de categorías/marcas y creación, edición, baja y reactivación de características/valores | `TaxonomyUserGuard` más `TaxonomyCommercialGuard`: usuario humano con `GESTOR_COMERCIAL`; no acepta un token de servicio para las mutaciones. |
| `listarCaracteristicas` | Usuario humano con `GESTOR_COMERCIAL`, mediante `TaxonomyCommercialGuard`. |
| `obtenerCaracteristica`, `listarValoresCaracteristica` | Humano `GESTOR_COMERCIAL` o servicio `modulo-productos` con audiencia `api-productos` y scope `catalogo:leer`, por metadatos del guard. **OpenAPI rc.3 declara solo `userBearer` en estas dos operaciones**: resolver con los owners de contrato y Gateway antes de depender de la alternativa M2M. |
| `listarTiposProducto`, `obtenerTipoProducto`, `obtenerEsquemaTipoProducto` | Humano `GESTOR_COMERCIAL` o servicio `modulo-productos` con audiencia `api-productos` y scope `catalogo:leer`; OpenAPI rc.3 declara ambas alternativas. |

`PUBLIC_READ_ONLY` puede permitir únicamente las operaciones de lectura incluidas explícitamente en `TAXONOMY_PUBLIC_OPERATION_IDS`, sin cabecera Authorization y según `phase1-public-reads.ts`; no demuestra que ese modo esté activo en Azure. Los 401/403 dependen de la causa y el guard; fallo del proveedor de Seguridad se trata como 503. La presencia de guards no acredita grants emitidos por G7 ni reenvío por Gateway.

Para los filtros `categoriaId` y `marcaId`, `Catalog` consulta Taxonomy. En `G7_AUTHENTICATED` el salto interno utiliza su identidad técnica `modulo-productos`; para `identity.user` llama los detalles administrativos y, en el otro caso, las listas comerciales. `TaxonomyClient` no convierte su credencial de usuario entrante en identidad M2M. Gateway, G7 y Catalog deben acreditar conjuntamente el grant efectivo y las rutas; las credenciales de servicio nunca van al navegador.

## Entorno QA y SHA desplegado

- **Datos de Azure proporcionados por el usuario, sin verificación independiente:** resource group `rg-g6-aca-chile`, Container App `taxonomy-svc`, revisión `taxonomy-svc--amqp-b061-1112` reportada Running/Succeeded, SHA de aplicación `b061ef86ec63a06ba626c3f7a66c94cd7fc270db`, imagen `ghcr.io/taller-sw-web/g6-productos-ofertas-backend/taxonomy-svc@sha256:48fd292c037d95032a7e31eafd74b4664daaf205511b57e5f02b27c8cc2328e0`. Gateway externo: `https://api-gateway.calmgrass-aec0b33c.chilecentral.azurecontainerapps.io/api/v1`. G7: login `https://g7-auth-service.onrender.com/api/v1/auth/login`, MFA `https://g7-auth-service.onrender.com/api/v1/auth/otp/verificar`, refresh `https://g7-auth-service.onrender.com/api/v1/auth/refresh`; MFA requiere `formatoAcceso: JWS` según lo comunicado. Esto no verifica por sí solo issuer/JWKS ni grants activos.
- Comparación Git del 13-11-2026: `b061ef8` es ancestro de `origin/master` `95f43e4e826e03679694a95ce6036677c8011f9e`, con 20 commits posteriores. `git diff b061ef8 origin/master -- apps/taxonomy-svc apps/api-gateway` no mostró diferencias: las 26 rutas del inventario están declaradas en el código de ese SHA; no demuestra su configuración o respuesta efectiva en Azure. La información de revisión/digest reportada requiere comprobación independiente del recurso Azure.
- Consulta de despliegues GitHub: solo se observaron entradas Oracle históricas, no una entrada Azure que acredite el SHA de Taxonomy. La PR #212 de CD Azure sigue abierta y declara que no ejecutó despliegue remoto. No se dispone aquí de Azure CLI ni de acceso verificado a la suscripción o al runtime.
- Owner Azure/Infra: acreditar mediante consulta al recurso la revisión, digest y `org.opencontainers.image.revision` del contenedor `taxonomy-svc`. Owner G7: confirmar issuer/discovery/JWKS y grants; no incluir tokens ni secretos en el inventario. El SHA de la rama o de CI no sustituye el SHA desplegado.

## Evidencias y pendientes por separado

- Código: rutas observadas en el corte indicado; revisar semántica, payloads y todos los status contra el contrato.
- Verificación local de ese corte: `npm test -- --fileParallelism=false apps/taxonomy-svc` PASS, 344/344; `npm run build:taxonomy-svc`, `npm run typecheck` y `npm run lint` PASS. Lint informó una advertencia existente en Bulk. Estas pruebas no acreditan todas las operaciones de esta tabla ni una instalación remota.
- `node scripts/ci/run-taxonomy-integration.mjs`: FAIL durante el preflight porque el motor Docker no estaba disponible; no se ejecutaron las pruebas PostgreSQL de esa corrida.
- Retest del 13-11-2026 sobre `e01669619c8f09cdaab2c813cff1a56557dd803d`: `node scripts/ci/run-taxonomy-integration.mjs` PASS, **71/71**, sin omitidas, PostgreSQL desechable. Esta corrida no acredita un despliegue ni grants G7 reales.
- Nueva ejecución del 13-11-2026 sobre el mismo HEAD: `node scripts/ci/run-taxonomy-integration.mjs` PASS, **71/71**, sin omitidas. Documentación y ejecutor QA tienen cambios locales sin commit; no cambian el código productivo probado.
- Pruebas locales: registrar comandos, SHA, resultados y 401/403 de usuarios y servicios por operación; no presentar fixtures como G7 real.
- PostgreSQL: retest aislado completado; no aplicar SQL a Supabase compartido.
- G7: owner Seguridad, grants y roles efectivos para `GESTOR_COMERCIAL` y filtros; pendiente JWT real y prueba autenticada por operación.
- Gateway/Azure: owner de despliegue e integración, verificar independientemente revisión/imagen/SHA reportados y probar rutas y headers con G7. Datos de entorno aportados por el usuario; aún sin retest autenticado.
- Frontend/Vercel: owner frontend, conectar adapters solo para operaciones acreditadas y mantener errores visibles; confirmar CORS y sesión con los respectivos owners.
- QA CRUD: requiere datos de prueba autorizados y ejecución de mutaciones en entorno QA identificado; pendiente identificar entorno, datos y autorización. No confundir con pruebas unitarias.

## Ejecutor QA preparado, aún sin ejecutar en Azure

`node apps/taxonomy-svc/test/qa-gateway-admin.mjs --check` valida el ejecutor y el archivo PNG local sin solicitudes ni tokens. Para la ejecución real se requiere `JWS_GESTOR_COMERCIAL` válido y firmado con RS256, y `QA_CLEANUP_LOGICO=aceptado`. `JWS_SIN_PERMISOS` es opcional; si se incluye, debe ser un JWS válido distinto. Sin él se ejecuta el resto y la evidencia registra el 403 como `PENDIENTE` y el resultado como `PARTIAL`, si no hubo otros fallos. Inyectar los tokens mediante el mecanismo seguro del operador, nunca en argumentos, archivos de repositorio, evidencia ni conversaciones. Después ejecutar:

```powershell
$env:QA_CLEANUP_LOGICO = 'aceptado'
node apps/taxonomy-svc/test/qa-gateway-admin.mjs
```

El ejecutor fija el origen QA reportado, comprueba el 401 mediante `POST /categorias` sin token y registra por separado el estado de `GET /caracteristicas` anónimo; el 403 requiere el segundo JWS. Cada solicitud tiene un timeout de 45 segundos. Las lecturas y cada flujo CRUD se intentan independientemente aunque falle una comprobación anterior; un flujo que no obtiene el ID tras crear no puede leer, actualizar ni limpiar ese registro de manera segura. Categorías y marcas se limpian mediante baja asíncrona y se comprueba `COMPLETED` e `INACTIVO`; características mediante desactivación y lectura posterior. **Las bajas son lógicas: los registros permanecen en la base.** Un timeout, una respuesta de creación sin ID o una baja no confirmada requieren reconciliación manual; el script no elimina registros ajenos ni reintenta ciegamente escrituras. Los resultados se guardan fuera del repositorio en un archivo temporal; se redactan credenciales y se registran solo conteos de listados.

`node --test apps/taxonomy-svc/test/qa-gateway-admin.test.mjs` prueba localmente con respuestas simuladas el recorrido, la limpieza y la redacción; no acredita la API de Azure. No se ha ejecutado el CRUD remoto ni se ha verificado independientemente el SHA desplegado.

## Primer intento QA por Gateway: 13-11-2026

- Evidencia sanitizada facilitada por el operador: `taxonomy-qa-9uuYWe/evidence.json`; ejecución `22:05:14Z–22:05:29Z`. SHA de Taxonomy `b061ef86ec63a06ba626c3f7a66c94cd7fc270db` reportado por el usuario, no verificado por el ejecutor.
- Resultado `FAIL`: la primera petición, `GET /api/v1/caracteristicas` sin credenciales, agotó el tiempo de espera o tuvo un error de red (`ERROR_RED_O_TIMEOUT`). No se recibió ni registró código HTTP; el ejecutor no guarda la causa de red detallada. No hubo respuestas positivas ni negativas acreditadas por esa ejecución y el 403 quedó `PENDIENTE`.
- La evidencia contiene `created: []` y solo una petición GET; el flujo se detuvo antes de cualquier POST/PATCH o solicitud de baja. Por tanto no hay registros creados ni bajas pendientes atribuibles a esa ejecución. No afirma ausencia de registros QA preexistentes.
- Retest independiente de solo lectura, sin credenciales, `GET /api/v1/caracteristicas`: `curl` obtuvo HTTP 200 a las `22:06:49Z`, `X-Correlation-Id: db4711ae-a758-494c-8eb8-a187324a9903`; Node `fetch` también obtuvo HTTP 200, correlación `cedb5842-7042-4f9d-81ed-05c6a48368d2`. Se descarta solo una interrupción persistente en esos instantes; la causa del timeout inicial sigue indeterminada.
- La versión usada en ese intento asumía 401 sin token y detenía el CRUD si no lo obtenía. El ejecutor ahora comprueba el 401 en una escritura y registra el GET anónimo por separado. El 200 observado requiere verificar con Gateway/Taxonomy y el owner de seguridad si el modo `PUBLIC_READ_ONLY` y esa operación están autorizados y configurados en QA. El 403 requiere un JWS real de una cuenta sin `GESTOR_COMERCIAL`.

## Segundo intento QA por Gateway: 13-11-2026

Fuente: evidencia sanitizada `taxonomy-qa-aUFvu2/evidence.json`, facilitada por el operador; inicio `22:22:13Z`, fin `22:24:24Z`. El Gateway y los handlers respondieron con un JWS real de `GESTOR_COMERCIAL`. El SHA Azure `b061ef86ec63a06ba626c3f7a66c94cd7fc270db` fue **reportado**, no verificado por el ejecutor. Esta evidencia acredita el recorrido ensayado, no todas las operaciones del inventario, homologación integral ni CI de ese SHA.

| Prueba | Método y ruta relativa a `/api/v1` | HTTP observado | Resultado |
|---|---|---:|---|
| Escritura sin credenciales | POST `/categorias` | 401 | PASS, `TOKEN_INVALIDO` |
| Lectura anónima | GET `/caracteristicas` | 200 | Observación: lectura pública; verificar política QA |
| Árbol administrativo | GET `/categorias/arbol` | 200 | PASS |
| Listado administrativo de categorías | GET `/categorias/administracion?pagina=1&tamanio=20` | 200 | PASS |
| Listado administrativo de marcas | GET `/marcas/administracion?pagina=1&tamanio=20` | 200 | PASS |
| Listado administrativo de características | GET `/caracteristicas?pagina=1&tamanio=20` | 200 | PASS |
| Creación de categoría | POST `/categorias` | 201 | PASS |
| Lectura de categoría QA | GET `/categorias/{categoriaId}` | 200 | PASS |
| Edición de categoría QA | PATCH `/categorias/{categoriaId}` | 200 | PASS |
| Creación de marca | POST `/marcas` | 201 | PASS; respuesta `logoUrl: null` |
| Lectura de marca QA | GET `/marcas/{marcaId}` | 200 | PASS |
| Edición de marca QA | PATCH `/marcas/{marcaId}` | 200 | PASS |
| Creación de característica | POST `/caracteristicas` | 201 | PASS |
| Lectura de característica QA | GET `/caracteristicas/{caracteristicaId}` | 200 | PASS |
| Edición de característica QA | PATCH `/caracteristicas/{caracteristicaId}` | 200 | PASS |
| Desactivación de característica QA | POST `/caracteristicas/{caracteristicaId}/desactivar` | 200 | PASS; GET posterior 200 confirmó `INACTIVO` |
| Admisión de baja de marca QA | POST `/marcas/{marcaId}/desactivar` | 202 | PASS de admisión, **no** de baja terminal |
| Seguimiento de baja de marca QA | GET `/taxonomia/operaciones/{operationId}` | 200 | HTTP PASS; resultado funcional **REJECTED**, no inactiva |
| Admisión de baja de categoría QA | POST `/categorias/{categoriaId}/desactivar` | 202 | PASS de admisión, **no** de baja terminal |
| Seguimiento de baja de categoría QA | GET `/taxonomia/operaciones/{operationId}` | 200 | HTTP PASS; resultado funcional **REJECTED**, no inactiva |
| Usuario sin rol `GESTOR_COMERCIAL` | Prueba 403 | — | PENDIENTE: no se usó una segunda cuenta |

Las dos operaciones pasaron de `PENDING_DEACTIVATION` a `REJECTED` aproximadamente un minuto después de la admisión; en ambos casos `result: null` y `code: null`. Una lectura posterior de solo consulta confirmó que permanecían `ACTIVO`:

- Marca `9f753273-be66-4a44-a533-1e3adff9d929`; operación `5942083e-e370-4c87-a5c4-c707bf564d29`.
- Categoría `18c2521c-2a13-4571-9b0c-e0575436db26`; operación `d9f76fef-7862-4510-85df-21f2ed9220bb`.
- La característica `4f83999f-5c24-4ebe-9153-e6fb8713f4f2` quedó `INACTIVO` según el GET de la ejecución.

Revisión del código del SHA comparado: `DeactivationRecoveryRunner` ejecuta la recuperación cada 10 segundos. `recuperarVencidas()` lee `MASTER_DEACTIVATION_TIMEOUT_SECONDS` de `taxonomy.runtime_settings` (la migración establece 60 como valor inicial sin sobrescribir uno existente); para operaciones vencidas y versión/estado concordantes restaura la entidad a `ACTIVO`, marca internamente `FAILED`/`TECHNICAL_FAILURE` y registra un rechazo en Outbox, dentro de una transacción. La consulta HTTP mapea `FAILED` a `REJECTED` y devuelve `result: null` si no hubo resultado de check. El comportamiento observado es **compatible** con esa recuperación, pero la evidencia HTTP no demuestra el valor de configuración aplicado, la causa interna ni ausencia de defectos: Catalog/Infra deben revisar logs, Outbox/Inbox, broker, entrega y correlación antes de diagnosticar. No repetir escrituras ni reconciliar directamente esos registros sin coordinación.

**Requisito de Frontend:** tras un 202, conservar `operation_id`, consultar el estado hasta un resultado terminal y tratar `COMPLETED` y `REJECTED` por separado. `REJECTED` puede venir con `result` y `code` en `null`; no presentar la admisión como baja completada ni asumir que el rechazo significa `IN_USE`.
