# DATA-003 (#13): precios de demostración de Inka Athletics

**Estado: PARTIAL / IMPLEMENTAR_PARCIAL.** Preparación y auditoría completadas el
16/10/2026. No hay SKU publicado en el destino auditado: los cinco productos y
las seis variantes están en BORRADOR. No se puede cerrar el criterio de matriz
trazable a SKU publicados. No se modificó la base de datos.

## Destino, alcance y rama

- Organización: mrcastilla8's Org (`dqnklswllanhjwhenita`).
- Proyecto: Modulo de Productos y Ofertas (`slzglmtiyrzygpkiuthf`).
- Owner: Leonardo Vera; rama local y remota `vera`, base
  `5bb832b103f9cca4d0967fecde26c1ebccd05944`.
- La rama contiene el monorepo y el avance está publicado en el
  [PR #118](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/pull/118).
  Esta corrección sustituye los commits propios de vera por un commit limpio
  sobre su base existente. El SHA vigente y su CI se consultan en el PR.
- [Issue #13](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/13)
  y [política INFRA #1](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/1)
  autorizan este directorio. La corrección de auditoría solicitada autoriza
  agregar la suite específica en `.github/workflows/ci.yml`. No se alteran
  aplicaciones, contratos, migraciones, grants ni registry.
- Los precios son sintéticos y se conservan desde la baseline existente.
  No son cotizaciones de fabricantes ni ofertas oficiales de Inka Athletics.

## Reconciliación y matriz para Combos y Promociones

| Dato observado | Resultado |
|---|---:|
| Definiciones de precio / vigencias | 5 / 5 |
| Vigencias efectivas al auditar | 5 |
| Solapamientos, conflictos de canal/objetivo o versión | 0 |
| Moneda / canal efectivo | PEN / global (`null`) |
| Precios de oferta / programaciones | 0 / 0 |
| Productos / variantes / identidades SKU | 5 / 6 / 11 |
| SKU vendibles publicados con identidad coherente | 0 |
| Variantes sin entrada correspondiente en sku_identity | 0 |
| Filas de precio nuevas propuestas | 0 |

No se debe duplicar un precio por cada talla: SPEC-013 establece herencia del
producto salvo override explícito. Las cinco definiciones existentes cubren los
siete SKU potencialmente vendibles conocidos. Los cuatro SKU base de productos
con variantes son referencias de ficha, no unidades vendibles.

| SKU potencialmente vendible | Artículo | Precio regular sintético | Identidad SKU | Estado comercial |
|---|---|---:|---|---|
| ADI-ENT22-AZU-M | Camiseta adidas Entrada 22 | S/ 79.90 | Existe | BORRADOR |
| NIK-PITCH-05 | Balón Nike Pitch | S/ 89.90 | Existe | BORRADOR |
| PUM-ULP-NEG-42 | Chimpún Puma Ultra Play | S/ 219.90 | Existe | BORRADOR |
| ADI-RF3-GRI-38 | Running adidas Runfalcon 3.0 | S/ 249.90 | Existe | BORRADOR |
| ADI-RF3-GRI-39 | Running adidas Runfalcon 3.0 | S/ 249.90 | Existe | BORRADOR |
| NIK-REV7-NEG-41 | Running Nike Revolution 7 | S/ 279.90 | Existe | BORRADOR |
| NIK-REV7-NEG-42 | Running Nike Revolution 7 | S/ 279.90 | Existe | BORRADOR |

Todos heredan `origen=PRODUCTO`, `price_version=1`, PEN, canal global y
vigencia `[2026-10-01T05:00:00Z, infinito)` (medianoche de Perú).
Ninguna oferta está implícita. Se conserva el motivo histórico
“Precio inicial referencial de demostración” y actor nulo; no se atribuye
retroactivamente `ALTA_PRODUCTO`, un usuario, evento o auditoría inexistente.

[003_price_matrix.json](003_price_matrix.json) contiene las once referencias:
las siete anteriores y las cuatro bases no vendibles, con UUID reales de
producto, variante, definición y vigencia, versiones y bloqueos individuales.
Es una matriz de preparación para los owners consumidores; no acredita
disponibilidad comercial, respuesta HTTP ni una notificación enviada.

El modelo físico de Catálogo exige exactamente un propietario de identidad:
producto/base usa `product_id` y `variant_id=null`; variante usa `variant_id`
y `product_id=null`. El padre de una variante se obtiene de
`catalog.variants.product_id`. Las seis identidades de variantes ya existían:
el informe previo de faltantes se debía a exigir incorrectamente ambos IDs.
Se conservan los bloqueos reales por BORRADOR.

### Criterio comercial del escenario

Las bandas en PEN de la matriz son decisiones sintéticas de revisión, no
precios investigados del mercado: camiseta de entrada 50–100; balón recreativo
70–120; chimpún de entrada 180–300; running de entrada 200–330.
Los cinco valores existentes caen en esas bandas; el running difiere S/ 30
entre modelos sin inventar prestaciones que justifiquen más. No hay outliers
que exijan cambiar la baseline. Ropa y calzado conservan escalas diferentes.

Para accesorios sencillos se propone únicamente una banda orientativa 15–100.
DATA-002 aún no ofrece un artículo/SKU de accesorio: no se inventa uno ni se
asigna un importe para cumplir una cuota. Cualquier artículo fuera de estas
bandas requiere justificación por su segmento antes de preparar otro lote.
PEN corresponde al ejemplo; no se agrega una regla global de moneda.

## Reproducción y evidencia

1. Ejecutar el contenido completo de [001_pricing_audit.sql](001_pricing_audit.sql)
   con Supabase MCP en el proyecto indicado. Usa una sola transacción
   `REPEATABLE READ READ ONLY` y `SET LOCAL ROLE po_pricing_seed`.
2. Ejecutar por separado [002_catalog_references.sql](002_catalog_references.sql)
   con el acceso MCP de inspección autorizado. Solo consulta Catálogo; no
   concede acceso a Catálogo al rol seed de Pricing ni hace joins cross-schema.
3. Comparar el resultado con [004_read_only_evidence.json](004_read_only_evidence.json).
   Se registran columnas, constraints, índices, triggers y cuerpos de funciones,
   roles y permisos, filas concretas, vigencias y versiones. Las dos auditorías
   se repitieron sin diferencias salvo la hora de captura.
4. Ejecutar los checks locales:
   `node --test scripts/seed/mcp/pricing/verify.test.mjs`.
   Valida hashes, referencias completas,
   importes exactos, vigencias, herencia, bloqueos y alcance de lectura del SQL.
5. [manifest.json](manifest.json) fija destino, fuentes, SHA-256 por archivo,
   contenido del lote vacío, orden de inserción vacío, resultados y responsables.
   Los hashes verifican bytes UTF-8; no incluyen el manifiesto sobre sí mismo.
   El .gitattributes de este directorio conserva LF al pasar por Git.

Los SQL terminan con COMMIT de transacciones **solo lectura**. Esto no es un
ensayo de inserción con ROLLBACK ni una carga persistente. No se añadieron
price_audit, bulk, outbox, inbox, snapshots históricos ni eventos ficticios.
El login MCP es postgres; el rol efectivo de Pricing es po_pricing_seed.
Ese cambio de rol no prueba autenticación individual de seed_vera.

La prueba de regresión falla sobre la matriz anterior por identidad omitida.
La evidencia incluye una simulación reproducible mediante CTE de solo lectura:
con los mismos IDs y estados ACTIVO/ACTIVA simulados, la consulta anterior
cuenta 1 SKU y 6 falsos faltantes; la corregida cuenta 7 SKU y 0 faltantes.
Esos estados simulados no se escribieron en Catálogo ni acreditan publicación.
La suite específica está incorporada al workflow CI y no requiere credenciales.

RLS está deshabilitado en Pricing. La inspección efectiva confirma que anon y
authenticated carecen de USAGE del schema y SELECT de sus tablas; no se
concluye exposición pública por RLS deshabilitado ni se cambian permisos.
Los triggers inspeccionados comprueban línea temporal/versión y timestamps;
no publican eventos ni ejecutan llamadas externas.

## Normativa y límites

Fuentes oficiales fijadas en `c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b`
del [repositorio de documentación](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs):
Arquitectura, SPEC-013, modelo físico/migración de Pricing, OpenAPI y AsyncAPI,
registro DEC-F, trazabilidad y matriz intermodular. También se consultaron las
matrices y el registro en el SHA `942bf7322eb388fe5b0fcc9c5a565152e1099139`
referido por AGENTS.md. Las rutas exactas figuran en el manifiesto.

- DEC-F-006: herencia de producto/override SKU, canal específico/global,
  intervalos semiabiertos sin solapamientos y versión.
- DEC-F-009: repetir una lectura no produce efectos. No se acredita idempotencia
  de una inserción que no se ha ejecutado ni se ignoran conflictos de contenido.
- DEC-F-012: contratos `0.6.0-rc.1`, implementación, integración, homologación y
  despliegue se reportan por separado. No se altera ningún contrato.
- Canales normativos de Pricing: MARKETPLACE, CHATBOT, RETAIL, VENTAS.
  Se conserva el global permitido; no se inventan diferencias por canal.

## Dependencias y siguiente operación

| Owner | Operación afectada | Condición verificable de desbloqueo |
|---|---|---|
| Gabriel Poma / DATA-002 #12 | Validar SKU publicados y habilitar consumo comercial | Productos ACTIVO; variantes ACTIVA, IDs/versiones publicados y elegibilidad comercial confirmada por Catálogo. Las 11 identidades existen; el padre se resuelve mediante variants.product_id. Reauditar referencias y precios. |
| Marco Castilla + Leonardo Vera | Eventual carga si el catálogo definitivo incorpora referencias sin precio | Preparar un nuevo lote con contenido/hash y destino exactos; conformidad de Vera y aprobación explícita de Marco del alcance de ensayo y de persistencia conforme #13/#1. |

Publicar Catálogo no exige cambiar el importe ni reinicializar las cinco
definiciones válidas. Si las referencias finales coinciden, se actualiza la
evidencia de publicación y se mantiene el lote sin escrituras. No hay necesidad
de aprobación de G1/G4/G5/G7 para esta preparación interna.

La rama contiene package.json y las aplicaciones del monorepo. Los resultados
de la suite específica y de las validaciones generales se registran en el PR
para su SHA vigente. La integración HTTP autenticada, homologación y despliegue
no se han acreditado. DATA-003 permanece abierto como avance PARTIAL.

## Limpieza del historial de vera

La limpieza conserva el árbol corregido sobre la base indicada, sin incluir
`.env` ni los commits contaminados como ancestros de vera. Se publica únicamente
esa rama con `force-with-lease` sobre el SHA remoto previamente comprobado.
No se crean ramas ni se modifica master. La copia local de `.env` sigue ignorada.
La comprobación reproducible es `git log vera --all-match --format=%H -- .env`
(sin resultados), y la búsqueda de objetos alcanzables desde vera para esa ruta.

La limpieza de la rama no acredita revocación de la contraseña. El owner debe
rotarla; no se modificaron credenciales ni datos de Supabase. GitHub puede
retener commits por SHA, referencias internas de PR o cachés: su purga global
requiere gestión con [GitHub Support](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository).
