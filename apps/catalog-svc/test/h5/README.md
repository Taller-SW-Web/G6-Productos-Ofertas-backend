# H5 Catalog: estado INT-01

La suite `int01.contract.ts` es evidencia L0 de contratos y del registro de escenarios. No inicia procesos ni acredita que proveedores hayan participado. La ejecución real L1 queda `BLOCKED_DEPENDENCY` hasta que se cumplan todas estas condiciones:

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

`test/performance/h5/catalog-pagination-integrity.mjs` es el oráculo puro que el runner k6 de Vera deberá invocar fuera de la ventana de carga, antes y después del perfil. Obtiene la identidad completa del manifest: conjunto de productos elegibles activos (manifest menos `excluded_product_ids`), `product_id`, `sku_base`, y SKUs de variantes elegibles. A partir de los resultados paginados verifica `pagina`, `tamanio`, `total`, `totalPaginas`, tamaño de página, orden global `product_id:asc`, IDs/SKU base duplicados, faltantes, extras o IDs excluidos. A partir de `GET /productos/{productId}/variantes?canal=MARKETPLACE` compara pares `variant_id`/`sku` con variantes elegibles del manifest; los SKU simples derivan de `sku_base`. No lee ni escribe datos dentro del intervalo medido.

En la línea de comandos:

```powershell
node scripts/run-h5-vitest.mjs perf01
node --test apps/catalog-svc/test/h5/evidence-security.h5.mjs
```

Ese comando valida el oráculo puro y los negativos; no mide HTTP ni afirma integridad de un servicio real. La ejecución real PERF-01 requiere que Vera publique el módulo de runner k6 y su contrato de integración para este oráculo, autenticación sintética, origen Gateway loopback/isla, perfil/repeticiones y forma de exportar samples/comparador. Hasta entonces no se crea un framework k6 alternativo ni se ejecuta carga.

## Evidencia segura

`evidence-security.mjs` permite únicamente campos estructurados de la lista positiva y rechaza tokens, cookies, contraseñas, connection strings, DSN, URLs privadas y correos. Todo proceso hijo futuro se invocará con stdout/stderr a pipes; no se transmiten sus bytes directamente. El adaptador solo publicará códigos de estado/resultado allowlisted, conteos, hashes y duraciones. Los errores de aserción se convertirán a categorías estables, sin `message`, stack, request/response ni variables de entorno. Capturas, trace, HAR, video y attachments estarán apagados para L1. Si no puede mantenerse esta frontera, no se conserva el artefacto y la evidencia pasa a `BLOCKED_DEPENDENCY`.

Antes de conservar o publicar un artefacto textual se ejecutará `assertSafeEvidenceText` sobre los bytes UTF-8 decodificados. Los fallos de verificación rechazan el artefacto completo; no se intenta sanearlo después de almacenarlo. Los canarios sintéticos del test contractual verifican la detección de JWT, cookies, contraseñas, Authorization, DSN, credenciales, datos personales y endpoint privado M2M.

## Ejecución explícita

Desde la raíz Backend:

```powershell
node scripts/run-h5-vitest.mjs int01
```

La configuración incluye un archivo exacto y falla si no lo descubre. El wrapper captura y descarta la salida cruda, exige exactamente seis casos INT-01 o trece PERF-01 sin skips, y conserva un resumen allowlistado con SHA-256 en `apps/catalog-svc/test/h5/reports/`. Un suite vacío, incompleto, fallido u omitido no puede ser PASS. El reporter no publica nombres, aserciones, excepciones, stacks, encabezados ni variables de entorno. El test contractual prueba estructura/contratos y límites del polling, no levanta servicios. No hay todavía un runner k6 publicado por Vera en el árbol actual; P5 no crea otro framework y espera su interfaz documentada.
