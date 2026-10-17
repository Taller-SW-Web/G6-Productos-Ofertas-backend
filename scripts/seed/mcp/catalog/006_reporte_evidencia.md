# DATA-002 — Evidencia para reauditoría

**Estado:** lote corregido y preparado; no ejecutado en Supabase compartido. El alcance del PR #125 incluye catalog-svc #44 y DATA-002 (#12). La carga no cambia datos históricos ni contratos.

## Correcciones de datos

- Los 45 `identifying_key` ahora usan el contrato de `catalog.fn_assert_product(uuid)`: cada característica apunta a `{"valor_id":"UUID"}`.
- Las 90 filas de `variant_attribute_values` y las 6 de `product_attribute_values` guardan `valor` como objeto JSONB no nulo `{"valor_id":"UUID"}`. La carga ya no contiene `null::jsonb`.
- El estado de comparación embebido en el SQL y el manifiesto usan las mismas representaciones JSONB.
- La carga permanece transaccional e idempotente; no inserta manualmente `sku_identity`, no elimina ni actualiza filas existentes, y una divergencia aborta.

## Validación de Taxonomía

El preflight de solo lectura revisa 36 IDs (marcas, tipos, categorías, características y valores), valida que los valores pertenezcan a la característica esperada y comprueba 10 relaciones activas tipo/característica. Ambas consultas deben devolver cero filas antes de una carga autorizada.

Comparé los IDs contra los artefactos locales de Taxonomía: 25 aparecen en esos manifiestos y 11 no aparecen. La lista de IDs ausentes está en `002_manifest_catalogo.json`. Como pediste no ejecutar nada en Supabase compartido, el estado real `ACTIVO` de esos IDs y de las 10 relaciones queda **sin comprobar**. El preflight agregado no se considera evidencia de estado hasta ejecutarse como lectura autorizada contra el destino real.

## PostgreSQL descartable

La suite E2E ahora crea Taxonomía de prueba dentro del PostgreSQL descartable de CI y ejecuta:

1. Preflight activo sobre las referencias fixture.
2. Primera ejecución del lote completo.
3. Reejecución idéntica.
4. Postcheck de 15 productos, 45 variantes, 90 atributos de variante, 6 atributos de producto, 48 identidades vendibles y 48 filas de imagen (45 de variante y 3 de producto).
5. Conflicto intencional tras cambiar el payload de un producto; la carga debe abortar con `DATA-002 contenido diferente en catalog.products`.

**CI PostgreSQL del commit de código `cb538e4e54fcdfd0b5fab18be4d81bacb7ac1974`:** [run #139](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/39013214247) terminó `success`. En los logs, `apps/catalog-svc/test/postgres.persistence.e2e-spec.ts` aparece con **6/6 pruebas aprobadas**, incluida `validates the DATA-002 batch in disposable PostgreSQL`; no se omitió ninguna prueba de esa suite. El E2E total fue 356 PASS y 33 omitidas de otras suites (incluidas suites PostgreSQL read-only ajenas al alcance); no se cuentan esas omisiones como PASS. La suite persistencia ejecutó preflight, primera carga, repetición idéntica, postcheck y conflicto de contenido en PostgreSQL descartable de CI. En local, `npm run test:e2e -- --maxWorkers=1` dio 346 PASS y 43 omitidas por falta de Docker. El PostgreSQL local instalado carece de `share/postgres.bki`, así que no puede iniciar un servidor descartable aquí.

## Evidencia de imágenes

`005_matriz_productos_imagenes.csv` amplía las 18 presentaciones con URL comercial de fabricante, cantidad de filas de imagen asociadas y fecha/estado de inspección visual. Hay 17 imágenes asociadas (45 filas de variante y 3 de producto; 48 asociaciones en total) y una presentación Manchester City bloqueada por Taxonomía, sin filas de carga. La inspección visual y carga pública de URLs fue documentada el 2026-10-16; no se volvió a consultar Storage compartido durante esta revisión.

## Comandos ejecutados en el workspace

| Comando | Resultado real |
|---|---|
| `npm test -- --maxWorkers=1` | PASS — 44 archivos, 395 pruebas |
| `npm run test:e2e -- --maxWorkers=1` | 346 PASS, 43 omitidas; no prueba PostgreSQL local |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm run format:check` | PASS |
| `npm run build:all` | PASS |
| `npm run build:catalog-svc` | PASS |
| `git diff --check` | PASS |

## Evidencia CI del SHA final

El commit de código indicado arriba pasó el run #139 enlazado; sus logs demuestran la ejecución de las seis pruebas PostgreSQL de persistencia y la validación DATA-002. El commit posterior que actualiza este reporte solo agrega el enlace y el resultado de esa ejecución; su propia verificación CI queda enlazada en la descripción actualizada del PR #125.

## SHA-256 del lote corregido

- Manifiesto `002_manifest_catalogo.json`: `9e89065f9a0cc2f40f9fa0c1be3e89f162ceea5b4af685ea18b8186ffa9b639a`
- SQL `003_carga_catalogo.sql`: `0531dafd1413e800f6d96739d5d234b388b22fb7ab3356915d4fd0cc4e059535`

Estos hashes corresponden a los archivos corregidos que se adjuntan para reauditoría; no autorizan su ejecución en Supabase.
