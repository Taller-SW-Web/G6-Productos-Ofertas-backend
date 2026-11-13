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

OpenAPI distingue `userBearer` y `serviceBearer`. El guard de Taxonomy valida JWT y audiencia `api-productos`; los permisos y clientes M2M permitidos dependen de la operación. Las escrituras y lecturas administrativas marcadas con los guards comerciales comprueban el rol humano `GESTOR_COMERCIAL`. La presencia de guard no acredita que G7 haya emitido un token con grants válidos ni que Gateway lo reenvíe. No usar credenciales de servicio en el navegador ni ampliar scopes unilateralmente.

Las dos listas comerciales `/categorias` y `/marcas` usan la seguridad declarada para ellas; son distintas de los listados administrativos. Revisar las rutas y autorizaciones M2M de filtros de productos con Catalog/Gateway y G7, sin asumir que una lectura comercial habilita un acceso administrativo.

## Evidencias y pendientes por separado

- Código: rutas observadas en el corte indicado; revisar semántica, payloads y todos los status contra el contrato.
- Verificación local de ese corte: `npm test -- --fileParallelism=false apps/taxonomy-svc` PASS, 344/344; `npm run build:taxonomy-svc`, `npm run typecheck` y `npm run lint` PASS. Lint informó una advertencia existente en Bulk. Estas pruebas no acreditan todas las operaciones de esta tabla ni una instalación remota.
- `node scripts/ci/run-taxonomy-integration.mjs`: FAIL durante el preflight porque el motor Docker no estaba disponible; no se ejecutaron las pruebas PostgreSQL de esa corrida.
- Pruebas locales: registrar comandos, SHA, resultados y 401/403 de usuarios y servicios por operación; no presentar fixtures como G7 real.
- PostgreSQL: ejecutar suites en instancia desechable; no aplicar SQL a Supabase compartido.
- G7: owner Seguridad, grants y roles efectivos para `GESTOR_COMERCIAL` y filtros; pendiente JWT real y prueba autenticada por operación.
- Gateway/Azure: owner de despliegue e integración, identificar URL, imagen y SHA desplegado y probar rutas y headers. No hay evidencia Azure asociada a este corte.
- Frontend/Vercel: owner frontend, conectar adapters solo para operaciones acreditadas y mantener errores visibles; confirmar CORS y sesión con los respectivos owners.
- QA CRUD: requiere datos de prueba autorizados y ejecución de mutaciones en entorno QA identificado; pendiente identificar entorno, datos y autorización. No confundir con pruebas unitarias.
