# Lectura paginada de selección comercial — diseño para revisión

Estado: propuesta técnica, **no contrato publicado ni endpoint implementado**.
Owner de dominio: Catálogo/Poma; revisión transversal: arquitectura G6 y consumidores
Frontend Pricing/Promotions/Inventory. No concede permisos ni habilita despliegue.

## Problema y solución actual comprobada

Los contratos vigentes permiten listar productos y variantes por producto. El
resolver administrativo humano acepta hasta 100 SKU conocidos; no enumera el
universo de SKU. El filtro interno de población vendible es M2M y no puede
exponerse al navegador. No se han inventado rutas para sortear esa frontera.

La corrección actual elimina preparación/características de las selecciones,
limita concurrencia a cuatro y conserva cache breve por identidad. En el mismo
fixture de 40 productos/240 SKU las lecturas de selección pasan de 80 a 40 con
idénticos SKU y orden. Para saldos conocidos, Inventory usa el resolver existente:
240 SKU requieren tres lotes y una página de resúmenes, sin variantes.

La selección completa aún recorre páginas de variantes en una carga fría.
Estas mediciones no certifican capacidad Azure ni eliminan globalmente N+1.

## Extensión aditiva propuesta

Definir en Docs una lectura administrativa paginada de identidades de selección,
con el mismo JWT humano y rol GESTOR_COMERCIAL. La ruta, operationId, versión,
DTO exacto y límites definitivos se deben revisar en el OpenAPI antes de añadir
un handler. No modificar respuestas existentes ni reutilizar una ruta privada M2M.

El modelo debe proyectar datos que ya posee Catálogo: identidad de producto y
variante cuando corresponda, SKU opaco, nombre comercial, categoría/marca por ID,
tipo y estados administrativos. Debe conservar la diferencia entre objetivo
PRODUCTO y SKU: no fabricar SKU para un padre ni omitir el objetivo padre que
Pricing necesita. Los nombres de Taxonomía se componen por lecturas compartidas,
sin SQL entre schemas y sin lógica comercial en Gateway.

Paginación de tamaño acotado (propuesta: máximo 100), orden por clave estable
de objetivo y cursor opaco; filtros explícitos de estado/búsqueda/categoría/marca.
Una proyección no incluye precio ni stock y no concede elegibilidad inferida.
Documentar qué sucede si el catálogo cambia entre páginas: reinicio explícito
o corte versionado, nunca duplicados/omisiones silenciosos.

## Integración y compatibilidad

Agregar operación humana a Gateway y APIM como código después del contrato,
con validación JWT, rol, límites, correlationId, Problem Details y herencia CORS.
Conservar todas las operaciones actuales. Habilitar el consumidor nuevo solo
con backend compatible; no sustituir un 404/403 por fixtures o por acceso M2M.
Las escrituras siguen verificando identidad/versión fresca y no usan una cache
de presentación para autorizar un cambio comercial.

## Evidencia exigida para adoptarla

- PostgreSQL aislado: una consulta acotada por página, índices y plan de ejecución
  sobre las columnas reales; sin N+1, lecturas cruzadas ni backfills.
- Fixtures de 240 y 1.000 SKU: mismo conjunto de objetivos, orden estable,
  paginación sin pérdidas/duplicados y distinción padre/variante/simple.
- Contar peticiones por ruta/escenario con los mismos datos antes/después.
  El consumidor no debe llamar preparación, características ni variantes por
  producto para construir esa proyección.
- Identidad: 401 humano inválido, 403 sin rol, M2M rechazado, cache aislada por
  usuario; 429 con Retry-After y 503/cancelación sin pérdida del borrador.
- Compatibilidad: suites de contratos existentes, Gateway/APIM y flujos de
  selección de Pricing/Promotions/Inventory. Homologación separada de despliegue.

La propuesta reduce la siguiente frontera de rendimiento; no es evidencia de
implementación, homologación, aprovisionamiento ni producción.
