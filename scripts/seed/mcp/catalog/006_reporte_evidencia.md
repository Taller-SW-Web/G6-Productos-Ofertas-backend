# DATA-002 — Evidencia

**PARTIAL / PREPARADO, NO EJECUTADO.** Solo lecturas Supabase, sin escrituras. Baseline: 5 productos, 6 variantes, 11 identities (7 vendibles), 0 imágenes de producto y 6 de variante.

Productos preparados: 15; padres con variantes: 12; simples: 3; variantes: 45; SKU nuevos: 48; históricos vendibles preservados: 7. Storage: 18 objetos verificados; 17 asociados y 1 bloqueado (Manchester City). Owner Taxonomía (López), asignación de categoría; desbloqueo con categoría activa compatible asociada a Camiseta deportiva.

Se consultaron nombre, MIME, tamaño y URL; las 18 URLs cargaron como imágenes y se inspeccionaron visualmente. UUID v5 estables en manifiesto. SQL revisado estáticamente, no ejecutado; no actualiza/elimina ni inserta sku_identity. Validación local: JSON válido; matriz CSV con 18 filas de presentación; IDs, SKU, slugs y combinaciones Color/Talla sin duplicados; referencias de Taxonomía presentes en el manifiesto; 18 rutas de Storage y URL asociadas; SQL sin DML ajeno ni inserción a sku_identity. Integración autenticada, homologación y despliegue no realizados. Pruebas del servicio no aplican a preparación de datos.

## SHA-256

- Manifiesto: SHA-256 `bf2ca33335543b863f2d92a9f2a8a70011a057711eaa71eaf3714e26b6faceb5`
- SQL de carga: SHA-256 `7ad4ba71d7abb1854b35cb6c21d8f406e9a34cc8ca072a3f71fadb90657761b7`
