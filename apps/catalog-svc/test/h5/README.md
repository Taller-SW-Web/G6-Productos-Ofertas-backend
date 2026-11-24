# H5 Catalog: estado INT-01

La suite `int01.contract.ts` es evidencia L0 ejecutable de contratos y del registro de escenarios. No inicia procesos ni acredita que proveedores hayan participado. Sus aserciones están fijadas al OpenAPI `0.7.0-rc.3` de Docs SHA `40524e96c6973f84d74160076781702fe2a3da19`; los casos recorren la superficie de crear/editar/activar, leer y reintentar preparación, consultar precio efectivo y consultar disponibilidad. Las respuestas usadas en L0 son sintéticas y se reportan como `simulated_providers`; no son INT-01 L1.

La ejecución real L1 conjunta requiere un recorrido de Gateway donde Catalog, Pricing e Inventory se hayan iniciado, consultado y participado efectivamente. Solo se acepta si los tres eventos comparten SHA Backend, operation ID y correlation ID, tienen autorización verificada y no se marcaron como simulados. Un proceso que solo inició o un servicio que solo fue consultado no cuenta como participación. La validación ejecutable vive en `int01-contract-oracles.mjs` y `verifyRealProviderTrace()`.

La ejecución real L1 queda `BLOCKED_DEPENDENCY` únicamente para los casos que requieren capacidades no disponibles, hasta que se cumplan estas condiciones:

1. #262 queda integrado oficialmente en `master`, con una revisión del diff de master que confirme el runtime, relay, Outbox y la inicialización que requiere la ruta vigente. No se copia ni se resuelve su rama desde Poma.
2. Los owners de Pricing e Inventory entregan seeders de prueba autorizados, con identidad de dominio y credenciales limitadas, y una forma verificable de consultar la preparación hasta estado terminal.
3. El owner de infraestructura confirma un transporte Service Bus local descartable o un namespace aislado aprobado, nunca uno compartido/operativo.
4. El harness común proporciona una forma soportada de iniciar los binarios de Catalog, Pricing, Inventory y Gateway desde el mismo SHA Backend; confirma el readiness TCP autenticado de cada base, asigna puertos únicos, captura stdout/stderr en memoria y ofrece una limpieza idempotente.
5. Se fijan identidades sintéticas válidas por contrato y scopes esperados de cada proveedor. No se aceptan tokens emitidos para G7 real.

Al desbloquearse, el runner deberá iniciar y registrar cada instancia (SHA, PID, puerto, base descartable y readiness), preparar Catalog desde `fixtures/h5/catalog/manifest.json` y Pricing/Inventory exclusivamente por sus seeders propietarios, y seguir el recorrido soportado por Gateway. Una traza de correlación deberá distinguir `started`, `queried` y `participating`; para los dos escenarios positivos, la participación efectiva debe probarse con evidencia contractual de una operación de cada proveedor, correlacionada con la respuesta autoritativa de Catalog. Un proceso iniciado o una respuesta simulada no cuenta como participación.

Los oráculos se fijan antes de ejecutar: `product_id`, `sku_base` y variantes vendibles proceden del manifest y de Catalog; el precio efectivo y su origen proceden de Pricing; el stock y la ubicación proceden de Inventory. El estado final de preparación se verifica por polling acotado. HTTP 202 solo acredita admisión. Cada resultado guarda el ID del escenario, hash del dataset, proveedores requeridos/iniciados/consultados/participantes/simulados, categoría de identidad/autorización, oráculo, resultado esperado/observado, nivel L1 y estado individual.

Los negativos cubren precio/stock ausentes, proveedor caído, identidad o scope denegado, versiones obsoletas, SKU cambiado y estado de preparación incompleto. Para fallo y recuperación de un proveedor, se detiene únicamente la instancia aislada, se espera la indisponibilidad contractual, se reinicia el mismo binario y se verifica recuperación con polling; nunca se provoca la caída de un recurso compartido. Un `finally` idempotente detiene todos los procesos registrados, cierra conexiones, elimina únicamente las bases/recursos descartables creados por el harness y comprueba su ausencia, incluso si falla una inicialización parcial.

Mientras falte una condición anterior, la ejecución L1 se informa como `BLOCKED_DEPENDENCY`, con el elemento, owner y evidencia faltante; no como PASS, SKIPPED exitoso ni prueba real. Los escenarios contractuales con simulaciones permanecen separados y se etiquetan `L0_CONTRACT`, con la lista de proveedores simulados.

## PERF-01 — integridad de paginación

`test/performance/h5/catalog-pagination-integrity.mjs` es el oráculo puro para muestras obtenidas antes y después de la ventana de carga. Compara el conjunto elegible con el manifest por `product_id`, `nombre`, `sku_base` y SKU de variante vendible; verifica paginación, metadatos, duplicados, faltantes, extras, exclusiones y orden determinista. El orden de administración fijado en Docs y en el manifest es `nombre:asc,product_id:asc`; el oráculo exige nombre, identidad y secuencia exactos.

`catalog-pagination.k6.js` es el módulo de escenario consumible por k6/Vera; usa la API estándar de k6 (`options`, `setup`, `default`, `teardown`) y no crea framework ni harness k6 paralelo. `setup()` y `teardown()` recorren todas las páginas elegibles y variantes activas fuera de la medición, verifican IDs, nombre, `sku_base`, SKU vendibles, orden, duplicados, faltantes y exclusiones, y comparan un hash del snapshot antes/después. Sus requests van con `h5_phase=preflight|postflight`; el request de carga solo consulta la primera página de administración y va con `h5_phase=measurement`. El adaptador de Vera debe filtrar built-in `http_req_*`, `http_reqs` y bytes por `h5_phase=measurement` para no mezclar preparación con carga. Requiere `BASE_URL` loopback, `SYNTHETIC_JWT`, `VU`, `DURATION`, `SEED=20261123`, `MANIFEST_SHA256`, `REPETITION` y el manifest Backend canónico. Las únicas parejas admitidas son `1/60s`, `5/180s` y `20/300s`, con repeticiones 1–3. No ejecuta carga hasta que Vera confirme la interfaz/exportación del runner y exista Gateway loopback aislado con JWT sintético. Mide duración y estado 200 del request Catalog, solicitudes HTTP y bytes del request de medición; 401/403/429 cuentan como errores inesperados. El gate custom es error inesperado menor a 1 % para el escenario 2xx.

En la línea de comandos:

```powershell
node scripts/run-h5-vitest.mjs perf01
node --test apps/catalog-svc/test/fixtures/h5/domain-seeder-harness.h5.mjs
node --test apps/catalog-svc/test/h5/evidence-security.h5.mjs
```

Esos comandos validan el oráculo puro, negativos y ciclo de vida de seeders. No miden HTTP ni afirman integridad de un servicio real. La integración real PERF-01 depende de que Vera consuma el módulo k6, confirme la interfaz de ejecución/exportación y otorgue un Gateway loopback aislado con JWT sintético. Hasta entonces no se ejecuta carga.

La preparación de datos usa `domain-seeder-harness.mjs`. El modo `dry-run` no llama a seeders ni escribe datos. `apply` exige opt-in explícito, un registry identificado `POMA_H5_DISPOSABLE`, DB loopback cuyo nombre inicie `h5_disposable_`, recursos marcados como creados por el harness y ausencia de destino Supabase, operativo o compartido. Los seeders de Pricing e Inventory deben registrarse por sus owners; sus DB no reciben escrituras directas de Poma. Si falta un seeder, `apply` falla antes de iniciar la preparación; en un error parcial, el harness limpia en orden inverso solo recursos registrados por sí mismo.

## Evidencia segura

`evidence-security.mjs` permite únicamente campos estructurados de la lista positiva y rechaza tokens, cookies, contraseñas, connection strings, DSN, URLs privadas y correos. Todo proceso hijo futuro se invocará con stdout/stderr a pipes; no se transmiten sus bytes directamente. El adaptador solo publicará códigos de estado/resultado allowlisted, conteos, hashes y duraciones. Los errores de aserción se convertirán a categorías estables, sin `message`, stack, request/response ni variables de entorno. Capturas, trace, HAR, video y attachments estarán apagados para L1. Si no puede mantenerse esta frontera, no se conserva el artefacto y la evidencia pasa a `BLOCKED_DEPENDENCY`.

Antes de conservar o publicar un artefacto textual se ejecutará `assertSafeEvidenceText` sobre los bytes UTF-8 decodificados. Los fallos de verificación rechazan el artefacto completo; no se intenta sanearlo después de almacenarlo. Los canarios sintéticos del test contractual verifican la detección de JWT, cookies, contraseñas, Authorization, DSN, credenciales, datos personales y endpoint privado M2M.

## Ejecución explícita

Desde la raíz Backend:

```powershell
node scripts/run-h5-vitest.mjs int01
```

La configuración incluye un archivo exacto y falla si no lo descubre. El wrapper captura y descarta la salida cruda, exige exactamente diez casos INT-01 o catorce PERF-01 sin skips, y conserva un resumen allowlistado con SHA-256 en `apps/catalog-svc/test/h5/reports/`. Un suite vacío, incompleto, fallido u omitido no puede ser PASS. El reporter no publica nombres, aserciones, excepciones, stacks, encabezados ni variables de entorno. El test contractual prueba estructura/contratos y límites del polling, no levanta servicios. No hay todavía un runner k6 publicado por Vera en el árbol actual; P5 no crea otro framework y espera su interfaz documentada.
