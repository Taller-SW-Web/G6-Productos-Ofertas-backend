# #49 — Preview agrupado de Marketplace

Base: `poma@6278b6867b5a87f5351f88b717798e0a0893ad5a`.
Contrato consultado: Docs `master@599c34f4e677c8792532e2cc31ac372473a10710`,
OpenAPI 0.6.0-rc.1, AsyncAPI 0.6.0-rc.3; SPEC-003/004,
DEC-F-001/002/006/009/011/012 y paquete operativo G1 H4.

## Cambio y equivalencia

`listDemoCandidates` mantenía una consulta de candidatos, una consulta de
imágenes por producto, otra de variantes por producto sin imagen propia válida,
y otra de atributos por producto con imagen válida. Ahora usa candidatos,
imágenes propias agrupadas por IDs, fallback agrupado solo para IDs sin imagen
propia válida, y atributos agrupados. Máximo cuatro SELECT, tres sin fallback,
uno si no hay candidatos; BEGIN/COMMIT no incluidos en ese recuento.

Se reutiliza la agrupación de atributos de `listCandidates`; las galerías
mantienen políticas separadas. Preview conserva principal DESC/posición/ID,
fallback posición/ID de imagen/ID de variante, duplicados y galerías sin límite
de 100. El modo interno read-demo conserva su política previa. No cambia el
predicado comercial ni la paginación SQL del modo normal.

Los filtros y maxCandidates+1 permanecen en la primera consulta. El snapshot
sigue siendo repeatable read/read only. Pricing conserva cuatro workers y el
descarte previo al total/paginación; no se modifica su cliente ni su servicio.

`CatalogTelemetry.measure` registra duración transcurrida, etapa y éxito,
también ante fallo, mediante SanitizedLogger. Etapas: DEMO_CANDIDATES_SQL,
DEMO_ENRICHMENT_SQL, DEMO_PRICING y DEMO_LIST_TOTAL. Pricing mide el tiempo del
conjunto concurrente, no la suma de latencias individuales. No se registran
consultas, cuerpos, URLs ni errores privados.

## Evidencia local y reproducción

Antes de editar producción se ejecutó `demo-list-equivalence.spec.ts`:
11 PASS contra el método anterior. La misma fixture y aserciones completas
se conservan: páginas 1/2 de 4/24, ASC/DESC, imágenes, atributos, ausencia de
imagen/precio, vacío, límite, filtros parametrizados y fallos DB/Pricing.

| Driver controlado (no PostgreSQL) | Antes | Después |
|---|---:|---:|
| SELECT, 4 candidatos | 10 | 4 |
| SELECT, 36 candidatos | 79 | 4 |
| Respuestas completas de las ocho páginas | baseline | equivalentes |

Comandos ejecutados durante esta fase:

- `npm test -- --maxWorkers=2 apps/catalog-svc`: 390 PASS.
- `npm run test:e2e -- --maxWorkers=2 apps/catalog-svc`: 111 PASS, 45 SKIP.
- `npm run typecheck`, `npm run lint`, `npm run format:check`,
  `npm run build:catalog-svc`, `git diff --check`: PASS.
- TypeScript explícito de los archivos E2E y helper legacy: PASS.

Vitest requiere TEMP/TMP en directorio escribible y permisos para HTTP local;
los fallos iniciales EPERM del sandbox no son fallos de la aplicación.
Docker no está disponible localmente. Los SKIP no acreditan persistencia/broker.

La prueba `PERF-49` de `postgres.persistence.e2e-spec.ts` ejecuta la referencia
congelada en `test/support/legacy-demo-list.ts` y la versión nueva contra los
mismos 36 productos PostgreSQL desechables. Compara respuestas completas,
filtros, desempates, galerías repetidas >100, placeholders, atributos y límite.
Emite JSON con consultas, duración SQL, Pricing y total por página de 4/24.
Pricing es una fixture explícita de 2 ms por llamada: no acredita su latencia
real ni autenticación. Ejecutar con Docker/OpenSSL mediante el script E2E
existente, también ejecutado por CI. Resultados remotos se registrarán en el PR.

## Límites

Sin benchmark Oracle nuevo ni Pricing real: presupuesto G1 de 7 segundos
NO VERIFICADO. Los 12,379/12,261/12,808 s del issue son históricos del SHA
9205eb4, no resultados de este cambio. No se puede concluir si Pricing sigue
siendo el cuello de botella hasta medir las cuatro etapas en el entorno real.
Owner Poma/Marco: ejecutar medición autorizada sobre el SHA desplegado, con el
mismo dataset y condiciones. Esto afecta validación de latencia/despliegue,
no la implementación local. No se hicieron cambios de base compartida,
autenticación, contratos, otras apps, infraestructura, merge ni despliegue.
