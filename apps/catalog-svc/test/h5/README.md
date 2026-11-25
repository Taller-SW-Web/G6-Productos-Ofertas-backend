# H5 Catalog: estado INT-01

`int01.contract.ts` y `int01.synthetic-exchanges.ts` producen evidencia L0. No inician los microservicios ni acreditan participación real. El replay valida método, ruta, query obligatoria, presencia del body, estado HTTP admitido y estructura de la respuesta según el OpenAPI `0.7.0-rc.3` del commit Docs `c9e1e5c217616d28229fccf5315fb97a1ae061a9`. Los intercambios sintéticos cubren listado/detalle comercial de productos simples y variantes, creación, edición/versionado, SKU inmutable, activación condicionada, precio específico/fallback global, precio ausente/inválido, saldo ausente/negativo, errores de proveedor y autorización. Cada caso está identificado en el reporter como `L0_CONTRACT`; respuestas sintéticas jamás se presentan como INT-01 L1.

La ejecución real L1 conjunta requiere un recorrido de Gateway donde Catalog, Pricing e Inventory se hayan iniciado, consultado y participado efectivamente. Solo se acepta si los tres eventos comparten SHA Backend, operation ID y correlation ID, tienen autorización verificada y no se marcaron como simulados. Un proceso que solo inició o un servicio que solo fue consultado no cuenta como participación. La validación ejecutable vive en `int01-contract-oracles.mjs` y `verifyRealProviderTrace()`.

La ejecución real L1 queda `BLOCKED_DEPENDENCY` únicamente para los casos que requieren capacidades no disponibles, hasta que se cumplan estas condiciones:

1. #262 está integrado oficialmente en `master` mediante el merge `c73ed61c533a21787d1dab22aa79cd83ff77da14`; su runtime, relay y Outbox son dependencias satisfechas y no se duplican desde Poma. La corrección CAT-D04 usa conexión TCP autenticada al PostgreSQL definitivo y tampoco se replica.
2. Los owners de Pricing e Inventory entregan seeders de prueba autorizados, con identidad de dominio y credenciales limitadas, y una forma verificable de consultar la preparación hasta estado terminal.
3. El owner de infraestructura confirma un transporte Service Bus local descartable o un namespace aislado aprobado, nunca uno compartido/operativo.
4. El harness común proporciona una forma soportada de iniciar los binarios de Catalog, Pricing, Inventory y Gateway desde el mismo SHA Backend; confirma el readiness TCP autenticado de cada base, asigna puertos únicos, captura stdout/stderr en memoria y ofrece una limpieza idempotente.
5. Se fijan identidades sintéticas válidas por contrato y scopes esperados de cada proveedor. No se aceptan tokens emitidos para G7 real.

Al desbloquearse, el runner deberá iniciar y registrar cada instancia (SHA, PID, puerto, base descartable y readiness), preparar Catalog desde `fixtures/h5/catalog/manifest.json` y Pricing/Inventory exclusivamente por sus seeders propietarios, y seguir el recorrido soportado por Gateway. Una traza de correlación deberá distinguir `started`, `queried` y `participating`; para los dos escenarios positivos, la participación efectiva debe probarse con evidencia contractual de una operación de cada proveedor, correlacionada con la respuesta autoritativa de Catalog. Un proceso iniciado o una respuesta simulada no cuenta como participación.

Los oráculos se fijan antes de ejecutar: `product_id`, `sku_base` y variantes vendibles proceden del manifest y de Catalog; el precio efectivo y su origen proceden de Pricing; el stock y la ubicación proceden de Inventory. El contrato de preparación es el objeto `ProductoPreparacion`: sus dependencias admiten `PENDING`, `COMPLETED` y `REJECTED`, con `manual_retry_allowed`; en producto simple hay `pricing` e `inventario`, y en producto con variantes el inventario se desglosa por variante. Solo `GET /productos/{productoId}/preparacion` con HTTP 200 puede producir estado terminal, y solo cuando todas las dependencias requeridas son terminales. `POST .../reintentar` con HTTP 202 exige `status=ACCEPTED` y UUID `operation_id`/`correlation_id` y siempre se clasifica no terminal. HTTP 401/403/404/409/503 no puede convertirse en terminal por el body; el estado `INDETERMINATE` no pertenece a rc.3. El polling solo consume HTTP 200 de la operación de lectura y tiene límite de tiempo/intentos.

Los negativos cubren precio/stock ausentes, proveedor caído, identidad o scope denegado, versiones obsoletas, SKU cambiado y estado de preparación incompleto. Para fallo y recuperación de un proveedor, se detiene únicamente la instancia aislada, se espera la indisponibilidad contractual, se reinicia el mismo binario y se verifica recuperación con polling; nunca se provoca la caída de un recurso compartido. Un `finally` idempotente detiene todos los procesos registrados, cierra conexiones, elimina únicamente las bases/recursos descartables creados por el harness y comprueba su ausencia, incluso si falla una inicialización parcial.

Mientras falte una capacidad de prueba aislada, la ejecución L1 se informa como `BLOCKED_DEPENDENCY`, con el elemento, owner y evidencia faltante; no como PASS, SKIPPED exitoso ni prueba real. Los escenarios contractuales sintéticos permanecen separados como `L0_CONTRACT`. Los contratos y la existencia del runtime de #262 ya pueden verificarse en la línea base oficial; la ejecución conjunta real de creación → preparación → activación requiere seeders, transporte, identidades y harnesses aislados de los owners. Ninguna suite copia commits de #262.

OpenAPI rc.3 no define una operación de cancelación de preparación: el escenario prueba el rechazo terminal por el `GET` existente y no inventa endpoint. Tampoco define una operación de escritura de saldo inicial de H5. La prueba negativa envía una respuesta sintética de Inventory con saldo negativo al oráculo y verifica rechazo; comprobar que Inventory rechaza una mutación negativa queda a cargo del seeder autorizado de su owner y se registra `BLOCKED_DEPENDENCY` hasta que exista ese mecanismo.

## PERF-01 — integridad de paginación

`test/performance/h5/catalog-pagination-integrity.mjs` es el único oráculo para Node y k6. PERF-01 consulta el catálogo **comercial** `GET /api/v1/productos?canal=...&pagina=...&tamanio=...&orden=NOMBRE_ASC`; `CHANNEL` es obligatorio y debe pertenecer a `MARKETPLACE|CHATBOT|RETAIL|VENTAS`. Los fixtures iniciales usan `MARKETPLACE`; las expectativas comerciales se filtran por `eligible_channels`, no por la elegibilidad administrativa. La semilla `20261123` conserva el conjunto entre canales y el orden estable `nombre ASC, product_id ASC`.

`catalog-pagination.k6.js` usa el lifecycle estándar k6 (`options`, `setup`, `default`, `teardown`) y no crea framework paralelo. `setup()` y `teardown()` validan todas las páginas y detalles vendibles **fuera de la ventana medida**: identidad producto/SKU, `product_id`, `sku_base`, variantes/SKU, metadata, orden global, duplicados, faltantes y extras/no elegibles. Comparan el digest del snapshot pre/post. Las iteraciones medidas recorren de forma determinista todas las páginas por `iterationInTest % totalPages`. Todas las solicitudes se etiquetan `h5_case=PERF-01`, canal, perfil, repetición y `h5_phase`; Vera filtra métricas built-in y custom por `h5_phase=measurement`.

El escenario requiere `BASE_URL` loopback, `SYNTHETIC_JWT`, `SOURCE_SHA`, `CHANNEL`, `VU`, `DURATION`, `SEED=20261123`, `MANIFEST_SHA256`, `REPETITION` y el manifest Backend. Los perfiles válidos son `1/60s`, `5/180s`, `20/300s`, con tres repeticiones. El summary exporta p50/p95/p99, RPS 2xx, bytes de respuestas, errores inesperados, SHA de fuente, SHA Docs y dataset. Los contadores 2xx, 401, 403 y 429 son independientes; 401/403/429 se consideran errores inesperados en el escenario nominal. Los casos negativos se ejecutan por separado.

La importación y el empaquetado del módulo se verifican con `k6 inspect` y `k6 archive`; el smoke ejecutable usa exclusivamente `BASE_URL=http://127.0.0.1:<puerto>` servido por `catalog-pagination.fixture-server.h5.mjs`, con token sintético local y un perfil de cinco segundos limitado a cinco solicitudes por segundo. El entorno portable H5 fija Node `22.23.5` y k6 `1.8.3`; activar con `. ..\.h5-toolchain\Activate-H5Tools.ps1` y ejecutar `node scripts/run-h5-perf01-k6-smoke.mjs`. El resultado aceptable es `PASS_SYNTHETIC_SMOKE` con preflight/postflight y hashes de snapshot coincidentes. Es únicamente una verificación de módulo/runtime contra el fixture, no una medición del Catalog real ni evidencia PERF-01 L1. El runner exterior exige proceso k6 sin fallos, iteraciones completas, tasa de errores dentro del gate, HTTP 2xx y preflight/postflight íntegros antes de clasificar un run real como `MEASURED`; `handleSummary` solo emite `PENDING_RUNNER_ADJUDICATION`. El smoke no llama a Azure, APIM, Supabase ni a un Gateway compartido. La integración de Vera requiere su interfaz versionada y Gateway aislado autorizado antes de medir servicio real.

En la línea de comandos:

```powershell
node scripts/run-h5-vitest.mjs perf01
node --test apps/catalog-svc/test/performance/h5/catalog-pagination.fixture-server.h5.test.mjs
node --test apps/catalog-svc/test/fixtures/h5/domain-seeder-harness.h5.mjs
node --test apps/catalog-svc/test/h5/evidence-security.h5.mjs
```

`run-h5-vitest.mjs int01` exige 16/16 pruebas; `perf01` exige 21/21. El fixture loopback está aislado en `127.0.0.1`, usa datos sintéticos y se cierra en `finally`; valida el módulo de respuesta contra el oráculo compartido, pero no es servicio real ni medición. Las pruebas negativas del adjudicador impiden acreditar `MEASURED` con preflight/postflight fallido o incompleto, ejecución parcial, fallo de proceso, runtime con errores, sin respuestas 2xx o fuera de tasa de error. El smoke k6 de loopback tampoco constituye carga real. PERF-01 real requiere que Vera consuma el módulo y fije su interfaz, además de Gateway loopback aislado con JWT sintético.

La preparación de datos usa `domain-seeder-harness.mjs`. El modo `dry-run` no llama a seeders ni escribe datos. `apply` exige opt-in explícito, un registry identificado `POMA_H5_DISPOSABLE`, DB loopback cuyo nombre inicie `h5_disposable_`, recursos marcados como creados por el harness y ausencia de destino Supabase, operativo o compartido. Los seeders de Pricing e Inventory deben registrarse por sus owners; sus DB no reciben escrituras directas de Poma. Si falta un seeder, `apply` falla antes de iniciar la preparación; en un error parcial, el harness limpia en orden inverso solo recursos registrados por sí mismo.

## Evidencia segura

`evidence-security.mjs` permite códigos de estado, categorías, contadores, IDs H5 sintéticos, hashes, duraciones y provenance. Rechaza JWT, cookies, contraseñas, headers Authorization, connection strings, DSN, credenciales codificadas, correos/datos personales y endpoints privados. Los subprocesses capturan stdout/stderr en pipes; no imprimen bytes crudos y no conservan logs de proceso. Errores se reducen a categoría allowlisted, nunca `message`, stack, request/response ni variables de entorno. Capturas, HAR, trace, video y attachments sensibles están desactivados. Si una evidencia no pasa la verificación previa, se rechaza completa y no se publica.

Antes de conservar o publicar un artefacto textual se ejecutará `assertSafeEvidenceText` sobre los bytes UTF-8 decodificados. Los fallos de verificación rechazan el artefacto completo; no se intenta sanearlo después de almacenarlo. Los canarios sintéticos del test contractual verifican la detección de JWT, cookies, contraseñas, Authorization, DSN, credenciales, datos personales y endpoint privado M2M.

## Ejecución explícita

Desde la raíz Backend:

```powershell
node scripts/run-h5-vitest.mjs int01
node scripts/run-h5-vitest.mjs perf01
```

Cada configuración enumera los archivos especiales de manera explícita y falla si no descubre exactamente 16 INT-01 o 21 PERF-01; suite vacía, prueba omitida, pendiente o con error no produce PASS. El wrapper captura y descarta stdout/stderr crudos, conserva resultados individuales de escenario con nivel L0, y genera manifests e índices SHA-256 externos en `apps/catalog-svc/test/h5/reports/`. El reporter no publica aserciones, excepciones, stacks, headers ni variables. k6 `1.8.3` está instalado para validar importación, archive y smoke contra loopback sintético; el runner/interfaz de Vera y el Gateway aislado aún no están disponibles para medir Catalog real. La instalación y el smoke no acreditan carga PERF-01 L1.
