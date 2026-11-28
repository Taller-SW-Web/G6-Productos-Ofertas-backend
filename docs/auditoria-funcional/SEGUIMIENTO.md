# Correcciones de auditoría funcional — 28/11/2026

## Alcance, baseline y gates

Encargo sin issue único: corregir los informes `01`–`14` y `AVANCE.md` de
`docs/auditorias/funcional-vercel`, siguiendo A → B → C → D. Cada prueba local
acredita solo el escenario y revisión ensayados. **Validación local: PASS**.
**GATE_CODIGO=BLOCKED** por revisión técnica/autorización Draft→Ready y CI
integral de los HEAD finales aún pendientes; **GATE_DEPLOY=BLOCKED / NO_INICIADO**.
No se autoriza despliegue, merge ni escritura en
Supabase compartido. Los documentos fuente son originales ajenos a esta rama.

Rama local en ambos repositorios: `trabajo/castilla/correcciones-auditoria-funcional`.
Backend base inicial: `cb2f4b15feb822c6abdc35108ee60e7e16d9d1d1`.
Sincronización posterior por fast-forward: `aff71d96bc92125718d51ba6dca71483356cdc82`.
Frontend base: `02ada63217bfd448c7be621fbadfa6e48a325f64`.
Frontend corregido: `2f02aacc14689bb4ad1568be6d465781de5c5ab7`.
Docs inicial: `5f30802129ba4bbc0674dcc5878f10065f443118`; comprobación posterior:
`2b1b3dfb88077aadbcacb43a5df88923994f9ea6` (evidencias adicionales, sin cambios al OpenAPI utilizado).
Docs local tiene cambios previos sin commit; no se sobrescriben. Las referencias
normativas actuales se contrastan con `origin/master`, no se dan por actuales
las referencias históricas del checkout. Se preservan todos los archivos previos
no versionados de Backend y Frontend.

PRs preexistentes reutilizados, sin cambiar sus ramas:

- Backend #315 inicialmente abierto, HEAD `e7547f3e21aba23604347027b6f204c9dd575e88`:
  commits `6664511c`, `2a484ba0`, `e7547f3e`; guard humano, unitarias y HTTP.
- Backend #314 inicialmente abierto, HEAD `b2f53ccbc2c1f9e94b824734fa1447e8729a214d`:
  commits `d2be2277`, `6a5da558`; normalización APIM y regresiones XML.
- Frontend #104 Draft, HEAD `37b3a93b2b33d534e64f0dd73b7807fa709bf9eb`:
  Accept específico por operación para preservar el preflight permitido.

La nueva comprobación remota confirmó #314 fusionado a las 11:09:53 UTC y #315
a las 11:10:09 UTC del 28/11. Se incorporaron desde master, junto con #313.
No se hizo merge de PR ni se modificó master en esta ejecución. El diff final
no vuelve a añadir sus guards ni las políticas XML: solo amplía las pruebas
HTTP de Bulk y adapta la invocación local de Azure CLI a Windows. Un conflicto
add/add en la prueba HTTP se resolvió conservando la ampliación local tras
comprobar que el blob original de #315 coincidía exactamente con master.

Los checks consultados de #314 incluían 2 fallidos, 22 cancelados, 52 omitidos
y 28 exitosos; #315 29 exitosos y 1 omitido. Son estados de esos PRs, no de los
parches nuevos. No se pasa ningún PR a Ready sin revisión y autorización.

## Fuentes y decisiones

Arquitectura/seguridad: DEC-F-006 (precio/auditoría), DEC-F-009 (idempotencia),
DEC-F-011 (perfil físico) y DEC-F-012 (contratos/compatibilidad); registro y matriz
de trazabilidad DEC-F; política de seguridad progresiva; OpenAPI humano/M2M.
Para Bulk: ADR-H5 Service Bus Basic, topología, plan de migración, matriz externa,
inventario de mensajes y matriz ejecutable H5. No se añade transporte RabbitMQ.
UX: DESIGN 1.1.0, UXD-001/004/005/009/010/012, guías transversales; se reutilizan
Mantine, FeedbackAlert, SectionCard y los repositorios existentes.

G7 `NimbusFirmadorJws.java` en `Modulo-de-Seguridad-Backend/main` declara y genera
JWT humano RS256 sin `aud`. Justifica #315; no cambia el requisito M2M
`aud=api-productos`. G7 SPEC-06 H-11 dice memoria solamente y reload exige login.
El encargo autoriza expresamente una excepción temporal en G6 para reload:
sessionStorage contiene solo refresco e identidad esperada; G7 vuelve a emitir
identidad/roles antes de montar rutas protegidas. Nunca se restauran permisos
del navegador. La excepción se retira al disponer de un BFF con cookie HttpOnly
y política homologada; revisar antes de certificar D y como máximo el 15/12/2026.
XSS sigue pudiendo leer sessionStorage: no se presenta como protección contra
XSS. No se persisten access JWT, OTP ni contraseñas. Un hash de refresco consumido
en localStorage, serializado por Web Locks, impide reutilización accidental
entre pestañas duplicadas; no es una credencial ni concede permisos.

## Matriz progresiva de incidencias

Estados: CONFIRMADO_EN_CÓDIGO no prueba reproducción en producción. Los síntomas
del navegador provienen de la auditoría original; CORRELACIONADO no prueba causa.
La columna de pruebas se completa únicamente tras ejecutar comandos.

| ID / escenario | Clasificación y causa / supuesto | Archivos / tratamiento local | Antes → después / estado |
|---|---|---|---|
| Global reload / F01 | CONFIRMADO_EN_CÓDIGO: sesión en memoria y redirect antes de restaurar | main, G7Session, sessionPersistence; restauración asíncrona autoritativa | Reload, nueva pestaña, MFA, rotación/race/logout/expiración PASS; archivo auth-general completo PASS |
| BULK-01 | Síntoma funcional original; guard sin aud incompatible confirmado; no identificado emisor del 401 Azure | Reutilizar #315 y completar POST importación/exportación con dobles aislados | 9 HTTP PASS con GET y ambos POST/negativas; no equivale a digest desplegado |
| EXP-01/02 | CONFIRMADO_EN_CÓDIGO: invalidación por rechazo del servicio; GET permite un retry tras refresh | Clientes Bulk/Gateway/Catalog/Promotions/Reads/Taxonomy; no repetir POST | Matriz de 7 clientes × 5 fallos: 35 PASS; Bulk 99 unitarias PASS; navegador amplio y revalidación sin logout PASS |
| Bulk durable / B02 | CONFIRMADO_EN_CÓDIGO: createImportBatch permitía omitir intención; dos lotes históricos identificados sin causa original demostrada | Requerir intención antes de DB; receipt atómico y migración 0010 diferida para nuevas admisiones | 10 PostgreSQL R03/R14 PASS y 38 PostgreSQL 17 PASS; sin escrituras compartidas ni regularización inferida |
| INV-06 / PRI-03 | CONFIRMADO_EN_CÓDIGO: fallback global captura asset ausente; versión/caché de la auditoría no demostrada | vercel.json, RouteErrorPage; 404 de asset y recarga manual sin bucle | Conversor oficial Vercel 6.6.1 + HTTP local PASS: dos rutas profundas HTML/no-store, JS correcto/immutable y chunk ausente 404 sin HTML; regresión de boundary PASS |
| INV-01 | CONFIRMADO_EN_CÓDIGO: enriquecimiento solo bajo filtros de clasificación | apiInventoryAdapter y catalogMetadataResolver: resolver administrativo por lote, resúmenes paginados/cache por usuario; conservar saldos ante caída de Catálogo | 138 adaptadores y 8 hooks PASS; 240 SKU = 3 lotes + 1 página de productos, sin variantes/preparación; incluye producto inactivo |
| INV-02 | CONFIRMADO_EN_CÓDIGO: mapper pone nombre null; ubicaciones publica nombres | Composición con getLocations; mantener magnitudes y fallback explícito | Fixture de composición PASS; no cambiar saldos ni sembrar ubicaciones |
| INV-03 | Presentación ambigua confirmada por auditoría; contrato no filtra KPI por texto/catálogo | InventoryDashboardPage: alcance global en API; alcance mock explícito; alertas no se etiquetan globales | Navegador de inventario PASS; magnitudes no alteradas |
| INV-04 / OTH-01 | CORRELACIONADO: Accept global supera safelist; política no admite Accept en preflight | Reutilizar frontend #104; ingreso APIM coherente como código | Unitarias de cabeceras y navegador aislado PASS; Azure no certificado |
| INV-05 | Candidato de overfetch; 496 no es tasa ni benchmark | listVariantIdentities en endpoint existente; omitir preparación/características para selección | Mismo fixture de 40 productos/240 SKU: 80→40 consultas, mismo orden/identidad; no es benchmark Azure |
| PRI-01/02 | CANDIDATO respecto del síntoma original; callback inestable reproducido de forma aislada | Acotar consulta UI a 20 s, estabilizar callback por clave, cache de targets por identidad | 3 regresiones de callback/race/cancelación/timeout PASS; 166 Pricing PASS; escrituras siempre verifican Catálogo fresco |
| PRI-04 | CONFIRMADO_EN_CÓDIGO: read vuelve a recorrer targets; 429 original no causalidad probada | Cache corta de selección, lectura de identidades sin decoraciones ajenas, cooldown de lectura según Retry-After | 166 Pricing unitarias PASS; navegación y canal PASS; no inferir causa del 429 Azure |
| PRO-01 | CONFIRMADO_EN_CÓDIGO: selección requiere todas las variantes decoradas y no ofrece retry localizado | Identidades sin preparación; retry en selector; conservar selección y no clasificarla como histórica durante caída de Catálogo; Retry-After evita reenvíos de lectura durante espera | Regresión de cooldown PASS; navegador de recuperación PASS, asociaciones originales conservadas |
| TAX-01 | Candidato de segmentación, nunca se infiere QA por nombre | Estado contractual de categoría visible; filtro Activas/Inactivas/Todas, conservar referencias | 111 unitarias Taxonomía PASS; suites de interfaz dentro del navegador amplio PASS; una categoría QA activa no se oculta por texto |
| TAX-02 | CONFIRMADO_EN_CÓDIGO: contador null se presenta como ausencia | Consultar cantidad por fila bajo demanda usando el esquema vigente; no N+1 al abrir lista ni denominador ficticio | 2 regresiones PASS: recuento real del esquema y error recuperable distinto de cero |
| COM-01 | Discrepancia: HEAD ya contiene error arriba del editor, lejos de Agregar componente | Feedback también junto al control, conservar regla de unicidad | Regresión jsdom PASS en suite completa; intentos iniciales tuvieron selectores ambiguos/timeouts, corregidos sin retirar pruebas |
| PA-01 | Nulabilidad legítima; ausencia de actor no acredita sistema | Nombre comercial por lookup acotado/cache, motivo legible, conservar null y UUID histórico | Regresión PASS: 2 asientos/1 lookup, cache compartida por instancia y nulos intactos; no backfill |
| Catálogo peso 0.185 | CONFIRMADO_EN_CÓDIGO: decimalScale=2 redondea visualización del input | VariantFormFields/ProductFormFields; conservar precisión física | Regresión jsdom PASS: 0.185 kg y 12.345 cm, editar imagen conserva peso |
| Catálogo espacios al escribir | CONFIRMADO_EN_CÓDIGO: trim y control directo desde URL pierden texto al escribir | ProductsPage: borrador local inmediato, consulta normalizada con debounce de 250 ms y sincronización de navegación | Regresión de navegador PASS escribiendo tecla por tecla; conjunto Catálogo 20/20 PASS |
| Catálogo identificadores LISTA | CONFIRMADO_EN_CÓDIGO: modo inmutable imprime valorId | VariantFormFields: resolver etiqueta del esquema; conservar ID de la selección sin modificar payload | Regresión jsdom PASS: Color legible y mismo ID inmutable |
| Bulk CSV encabezado inválido | CONFIRMADO_EN_CÓDIGO: scanner solo sintáctico | Validar plantilla v2 en modo API antes de habilitar POST | 99 unitarias Bulk PASS; conserva compatibilidad mock; validación backend sigue autoritativa |
| Gateway/APIM B03 | #314 normaliza solo validate-jwt 401, no concede permisos | Reutilizar XML/tests; conservar CORS, base, scopes, rate limit | 32 pruebas de artefactos XML/Bicep PASS; políticas efectivas no certificadas |

## Escenarios manuales: tratamiento local y límite de certificación

- Promociones: `campaigns.spec.ts` comprueba alta/edición, fechas de Lima al ir
  al selector y volver, canales, colisiones, selección y cancelación. Se añadieron
  aserciones explícitas de ambas fechas. Prioridad conserva el entero contractual:
  el formulario ya explica que 1 es la mayor prioridad. Estado y vigencia son
  dimensiones distintas; no se cambia ACTIVO por inferir vigencia temporal.
- Combos: unitarias HTTP/intents y `combos.smoke.spec.ts` cubren creación,
  recuperación incierta, conflicto, no replay, selección, cambio/quitar componente,
  disponibilidad, confirmación/foco y retorno. COM-01 añade feedback junto al
  control existente. No se atribuye el 503 de una nota previa a escalado ni se
  añade borrado físico. La auditoría original no envió POST/PUT.
- Catálogo: `catalog.spec.ts`, `catalog-regressions`, `catalog-issue35`,
  `catalog-final-review` y adaptadores cubren CRUD, filtros, esquemas, referencias
  LISTA por ID y navegación. La búsqueda con espacios sí tenía un defecto.
  Tipo→esquema está vinculado por ID; el contrato de tipos no publica una relación
  Categoría→Tipo que permita inventar exclusiones. Se conservan ambos catálogos
  independientes. LISTA admite un valor contractual; no se convierte en array.
  Los enlaces Inicio ahora llevan a Productos.
- Preparación COMPLETED sin imagen: no equivale a activación. La preparación
  refleja inicialización independiente de Pricing/Inventory; `canActivateProduct`
  exige `imageValid`, y sus negativas se ejecutaron en la suite backend. No se
  fuerza una activación ni se confunden ambas condiciones.
- Cancelación: una edición vuelve al detalle de origen y un alta al listado,
  conforme al flujo existente comprobado. La nota previa no demuestra un fallo
  contractual; no se sustituye esta navegación por una regla global nueva.
- Traslados: la bandera de compatibilidad deja montar la UI; el servidor sigue
  exigiendo rol y capacidades `INVENTARIO_TRASLADOS_LEER/RECIBIR` por identidad.
  No se crean grants ni un supuesto endpoint de descubrimiento. Pruebas locales
  cubren 403 sin logout, recepción confirmada seguida de error de presentación,
  conciliación e intención incierta sin segundo POST. La autorización real queda
  para la certificación bilateral de D.
- Taxonomía: las suites recorren altas/ediciones, asociación/desasociación y
  operaciones de baja/reactivación. SEO identifica estado y permite segmentar;
  una categoría QA activa no se oculta por su nombre. El recuento se calcula del
  esquema bajo demanda, sin añadir campos al DTO ni un denominador inventado.
- Price Audit: filtros/paginación/exportación conservan su contrato. Se resuelve
  identidad comercial por lectura/cache; ausencia de actor no se presenta como
  Sistema. Moneda/canal ausentes siguen ausentes; no hay backfill.
- Cupones/Recomendaciones: fixtures de estado vacío, rechazo, referencias
  históricas, permisos y conciliación. No se consumen cupones compartidos.
- Umbrales/Bulk: fixtures de recepción, cancelación, plantilla/archivo inválido,
  MIME/nombre/tamaño, 202→seguimiento→archivo y resultados inciertos. El archivo
  vive en el contexto de edición; los marcadores de intención por usuario
  conservan conciliación tras recarga. No se reconstruye un File ni se reenvía
  una importación automáticamente después de una autenticación nueva.

Estos recorridos locales no certifican G7 real, grants, APIM, ACA, Vercel,
mensajería compartida ni homologación externa. Esa evidencia corresponde a D.

## Lotes históricos: lectura, sin regularización

Se consultaron solo metadatos de `bulk.batch_jobs`, filas, inbox y outbox en el
proyecto conectado. No se guardaron credenciales ni payloads comerciales.

| Lote | Correlación | Estado y evidencia del corte |
|---|---|---|
| `f11aaf4f-2866-4ea8-acf8-e4d1f4b5170c` | `cd45e67a-4118-4663-b576-bc1108292e4e` | Creado 07:12:48 UTC, PROCESSING, 1 fila, 0 completadas/0 fallidas, sin admission/inbox de resultado; comando Inventory entregado 07:12:49 UTC |
| `5afc2a53-5a18-4b86-b57a-69dacdf14abd` | `e1f58b24-d476-4dcd-a327-a35b580681ba` | Creado 07:18:10 UTC, PROCESSING, 1 fila, CATALOGO aplicado/INVENTARIO pendiente, sin admission/inbox de resultado; comando Inventory entregado 07:18:11 UTC |

Las operaciones de ajuste son `ebbdd12c-1b7a-46cb-a933-60447e4bdf1b` y
`cf1bc8df-65b5-49e2-9bcb-2889c37b0dc0`, respectivamente, con destino
`g6.inventory.from.bulk`. Esto prueba entrega registrada, no aplicación exitosa.
No se pudo atribuir su creación a un script o digest concreto. Se mantienen
segregados como bloqueo operativo de Castilla: recuperar intención original y
correlación de resultados antes de proponer una regularización aprobada.

## Migración nueva 0010 (no aplicada a Supabase)

Constraint trigger AFTER INSERT, DEFERRABLE INITIALLY DEFERRED: al commit exige
receipt con batch/correlación correctos y cobertura de filas. Aprovecha los índices
existentes de inbox y batch_rows; no hace HTTP ni escanea lotes históricos.
Se verifica con PostgreSQL descartable. La semántica se apoya en
[CREATE TRIGGER de PostgreSQL](https://www.postgresql.org/docs/17/sql-createtrigger.html).

Antes de aplicarla en D: verificar versión/digest de todos los writers, respaldo
y permisos del rol operativo; todos deben guardar receipt en la transacción.
Los registros previos permanecen intactos. El rollback debe conservar receipts
y no publicar comandos de admisiones no confirmadas. La aprobación de un PR de
código no autoriza ejecutar esta migración ni regularizar datos históricos.

## Despliegue y dependencias externas

Consulta ARM de solo lectura confirmó las mismas nueve revisiones/digests del
informe 12. GitHub deployments registra Vercel producción con SHA `02ada632` a
28/11 08:27:31 UTC. Esto no correlaciona imágenes GHCR con master ni certifica
tráfico funcional. No se ejecutó az update/deploy, Vercel deploy ni SQL compartido.

- Castilla / Bulk: recuperar intención original y causalidad
  de los dos lotes históricos; desbloquear regularización solo con evidencia y
  procedimiento aprobado, nunca inventando receipts.
- G7 / coordinación G6: revisar excepción temporal H-11 antes de certificación;
  integración genuina requiere grants y prueba bilateral por operación.
- Infraestructura G6: digests/manifiesto aprobado y políticas efectivas por
  operación se compararán en D tras PASS de C, sin adelantar despliegue.

## Runtime y reinstalación

Validaciones con `npx --yes --package=node@22.22.3 --call "<comando>"`.
El host Node 24.3 no satisface los engines. `npm ci --ignore-scripts` se ejecutó
en ambos repositorios sin cambiar locks: Frontend 282 paquetes, Backend 444,
audit reportó 0 vulnerabilidades. El typecheck inicial sin user-event falló;
la instalación limpia y las comprobaciones posteriores lo resolvieron.

## Unitarias Backend

`node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism --reporter=dot`:
**2.982 PASS / 106 omitidas**, después de sincronizar `aff71d96`. La ejecución
anterior fue 2.977 PASS / 106 omitidas. Las omitidas requieren entorno explícito;
no se contabilizan como pruebas de persistencia ejecutadas.

## Unitarias Frontend

`npm test`: **817 PASS** en las seis suites, más **35 PASS** de política de release.
Tras los últimos ajustes se ejecutaron además feedback de Catálogo y precisión
física (**8 PASS**) y composición de Inventario (**3 PASS**). Incluyen casos que
se solapan con el total anterior; no se suman para inflar una cifra única.

Baseline auth: 64 PASS. Matriz de siete clientes × cinco fallos: 35 PASS.
Se verifican 401 genérico/TOKEN_INVALIDO, 403, 429, 503 y red sin logout por
fallo incidental; GET/POST_READ pueden recuperar una vez, escrituras no se repiten.

## Integración Backend

`BULK_TEST_POSTGRES=1 CATALOG_POSTGRES_ONLY=1 node node_modules/vitest/vitest.mjs run --config vitest.config.e2e.ts --hookTimeout=120000 --reporter=dot`:
**1.003 PASS / 334 omitidas**, 48 archivos ejecutados y 31 omitidos.
Es la suite amplia previa a la sincronización; se repitieron después los guards
afectados (**15 PASS**) y HTTP Bulk + PostgreSQL R03/R14 (**17 PASS**).
La última ampliación de la migración se verificó con **10 PASS** en R03/R14:
admisión atómica, receipt fallido, receipt ausente/fila distinta/correlación distinta,
legado intacto, consumidor legado cerrado, redelivery y conflicto contradictorio.

## PostgreSQL 17

`node apps/bulk-svc/test/run-admission-postgres.mjs`: **38 PASS**, base descartable
en loopback, migraciones hasta 0010 y limpieza del contenedor. Imagen exacta:
`postgres@sha256:f9cf3e1f0066f0eb0c48707d864f0ac5941e9ff454a072077d97a4d278d07d73`.
Un primer intento del harness falló en cinco casos porque una variable de admin
vacía activaba el default localhost:5432; se eliminó esa variable del entorno de
prueba. La revalidación completa pasó. No se usó una URL de despliegue.

## Navegador

`playwright test --workers=1 --reporter=json`: **FAIL inicial**, 662 PASS,
7 fallidas y 8 omitidas de 677. Los fallos quedaron registrados y se corrigieron:
fixture de refresh inválido colocado en casos válidos, expectativa del bloqueo
antiguo de Traslados, CSV antiguo de dos columnas y clasificación histórica
durante indisponibilidad de Catálogo. Ninguna prueba fue retirada.

Revalidación completa de ocho archivos: **134 PASS / 5 FAIL intermedios**.
Los siete fallos iniciales ya pasaron; quedaron cuatro expectativas de códigos
técnicos de Catálogo y la nueva regresión de escritura rápida de búsqueda.
Después de corregir ambas líneas, `playwright test tests/catalog-http-ui.spec.ts
tests/catalog.spec.ts --workers=1 --reporter=line`: **20 PASS / 0 FAIL**.
Los archivos abarcan login/MFA/refresh/logout, 403 sin logout, CSV incierto sin
reenvío, recuperación de alcance, canal de precios y formularios/navegación.

No se declara que la suite completa haya terminado en exit 0 para el HEAD final:
la evidencia combina suite amplia y revalidaciones focalizadas. La CI integral
de la revisión actual sigue pendiente del paso autorizado Draft→Ready.

## Compilación

Backend `npm run build:all`: PASS. Frontend `npm run build` con modo API y orígenes
explícitos APIM/G7: PASS, 7.532 módulos. No se construyó ni publicó imagen OCI.
Advertencia de bundle existente: import dinámico/estático de seoRepository.

## Tipos

Backend `npm run typecheck`: PASS después de sincronizar master.
Frontend `tsc --noEmit` incluido en el último build API: PASS. Se corrigieron
errores de tipos de pruebas nuevas con narrowing explícito, sin any/ts-ignore.

## Lint y formato

Backend `npm run lint`: PASS con advertencias preexistentes. Frontend
`npm run lint`: PASS sin errores. Prettier de los archivos Bulk afectados: PASS.
`git diff --check` y `git diff --cached --check`: PASS.

## APIM

`python -m unittest discover -s ops/azure/apim/tests -p test_apim_artifacts.py`:
**32 PASS**, compilación Bicep local incluida. Quedan advertencias existentes de
estilo Bicep; no se ejecutó az deployment/create/update ni se aplicaron policies.

## Assets

`node --test scripts/build-vercel.test.mjs`: **7 PASS**.
`npm exec` con `@vercel/routing-utils@6.6.1` y `scripts/check-vercel-assets.mjs`:
PASS del conversor oficial y fixture HTTP sobre el último dist: rutas profundas,
MIME JavaScript, cache y 404 sin HTML. Boundary: PASS de recuperación manual,
conservación de destino y ausencia de bucle de recarga.

## Gate formal y revisión

Los cambios quedan en Draft. [AGENTS.md](../../AGENTS.md) exige: «Solo pasa el PR
a Ready for Review cuando se haya comunicado que la revisión terminó
satisfactoriamente y exista autorización para continuar». También difiere las
suites pesadas a Ready y exige checks obligatorios de la revisión actual.
No se sustituye esa revisión por la aprobación de la implementación propia.

Por ello GATE_CODIGO permanece BLOCKED para promoción, aunque las comprobaciones
locales detalladas hayan pasado. La siguiente acción es revisión de los PR,
decisión sobre la excepción temporal G7 H-11 y autorización de Ready; después,
CI integral para esos HEAD. No se inició Fase D. La selección completa conserva
una frontera de rendimiento descrita en [la propuesta de lectura](PROPUESTA_LECTURA_SELECCION.md).
