La base compartida tenía los ocho schemas, pero no un mecanismo de seeds con permisos separados del runtime. Este cambio añade un ejecutor declarativo que valida schema, entorno, tablas, columnas e identidades; shared solo admite verificación transaccional con ROLLBACK. Refs #1; no cierra el issue mientras falten accesos individuales y revisiones.

## Checklist de Gobernanza Obligatoria

- [x] Leí AGENTS.md completo antes de editar.
- [x] Trabajo en la rama personal cueva. El fast-forward a master local fue autorizado expresamente.
- [x] Cambios transversales limitados a scripts/seed y .env.example, autorizados por el issue; ningún microservicio ajeno modificado.
- [x] Consulté fuentes físicas/arquitectura/DEC-F; no inventé endpoints, DTOs ni eventos.
- [x] Ejecuté las cuatro validaciones obligatorias.
- [x] Sin credenciales reales ni mocks silenciosos de producción.
- [x] Alcance limitado a INFRA-001.
- [x] Declaro las pruebas y dependencias pendientes.

## Alcance y archivos

- scripts/seed/run.mjs y run.test.mjs: selección de destino, SSL verify-full, login/grupo restringidos, rechazo de demos en producción, una transacción y validación de contenido; un ID reutilizado con contenido distinto falla y revierte la carga.
- registry.json, dataset.json y required/demo por schema. Un único fixture reversible de Promociones; cargas de los demás contextos reservadas a sus owners.
- access/: auditoría, SQL original aplicado y corrección incremental de grants. .env.example y README/evidence documentan conexión, permisos, comandos y pruebas.

## Pruebas y evidencia

- node --test scripts/seed/run.test.mjs: PASS, 8 tests.
- npm test: PASS, 9 tests; npm run test:e2e: PASS, 9 tests.
- npm run typecheck, npm run lint, npm run build:all: PASS.
- oxlint scripts/seed, node --check y git diff --cached --check: PASS.
- Supabase PostgreSQL 17.11, proyecto slzglmtiyrzygpkiuthf: 84 tablas auditadas, owners conservados, cero FK cross-schema. Roles/grants aplicados con aprobación humana en dos entradas MCP: 20261013160902 y 20261013161315.
- SQL generado ejecutado dos veces bajo po_promotions_seed: una fila. Tras ROLLBACK: cero filas y mismo hash de datos/estructura. Ocho roles seed con USAGE propio, cero CREATE/acceso cruzado/membresías privilegiadas.
- Evidencia reproducible: scripts/seed/evidence.md y access/audit.sql.

## Pruebas no realizadas y dependencias

No se ejecutó el cliente psql con login individual: faltan instalación/credenciales privadas/CA del responsable. Los grupos NOLOGIN aplicados no equivalen a credenciales entregadas. El administrador debe provisionar esos accesos según la guía; los owners deben revisar el manifiesto y registrar sus cargas.

Los 23 avisos preexistentes de search_path de Supabase se mantienen y se documentan por owner. npm audit informa 5 dependencias dev preexistentes con avisos (2 high); no se actualizó el lockfile ni se ejecutó audit fix --force. El runner usa únicamente módulos nativos.

## Compatibilidad y revisión

No cambia OpenAPI/AsyncAPI, schemas de negocio ni owners; no se reescriben migraciones históricas. Los permisos nuevos se limitan a grupos seed y seis columnas de promotions.stock_projection. No hubo seed persistente ni despliegue de servicios.

PR en borrador: revisión técnica de Leonardo López e integración de Marco Castilla pendientes. Implementación interna y pruebas locales se informan separadas de psql individual, revisión de dataset y despliegue.
