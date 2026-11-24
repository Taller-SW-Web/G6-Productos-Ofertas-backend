# Fixtures sintéticos Poma H5

`manifest.json` es la fuente canónica Backend. El generador usa la semilla fija `20261123`, serialización JSON UTF-8 sin BOM, claves de objeto ordenadas recursivamente, sangría de dos espacios y un LF final. El SHA-256 se calcula sobre los bytes exactos del archivo y se registra como `<hex>  manifest.json` en `manifest.sha256`.

El dataset declara identidades estables de producto/SKU, elegibilidad, variantes, precios sintéticos por canal o globales y stocks observados por ubicación. Los precios y stocks son entradas para pruebas del dominio propietario; el fixture no escribe directamente en tablas Pricing ni Inventory. La preparación real de esos dominios requiere el seeder de pruebas autorizado por cada owner y una base descartable registrada por su harness.

Comandos desde la raíz Backend:

```powershell
node apps/catalog-svc/test/fixtures/h5/catalog-h5-fixture.mjs --write
node apps/catalog-svc/test/fixtures/h5/catalog-h5-fixture.mjs
npm test -- apps/catalog-svc/test/fixtures/h5/manifest.spec.ts
```

La ejecución predeterminada valida y presenta el plan sin escribir datos ni recursos. `--apply` falla con `APPLY_REQUIRES_REGISTERED_DOMAIN_HARNESSES` hasta que Catalog, Pricing e Inventory ofrezcan seeders registrados sobre recursos descartables. El harness registra recursos, pero no infiere ni inventa cuántas escrituras hizo un seeder propietario. No hay ruta de escritura a ambientes compartidos, Supabase o datos operativos.
