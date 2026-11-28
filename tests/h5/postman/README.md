# Suite Ejecutable de Pruebas de Integración HTTP — Postman / Newman (G6 Hito 5)

Este directorio contiene la **fuente única de verdad ejecutable** del harness Postman/Newman para la validación de integración HTTP de **G6 — Productos y Ofertas (Hito 5)**, trasladada desde `G6-Productos-Ofertas-docs` hacia el repositorio Backend con dependencias completamente aisladas (sin modificar el `package.json` raíz ni los workflows de CI/CD).

> **Estado operativo actual (`STANDBY` en infraestructura real):** No se ejecutan pruebas contra Azure APIM, ACA, Service Bus ni G7 mientras existan PR de CI/CD en curso (`Backend #310`, `Frontend #103`) y correcciones pendientes en APIM/Bulk. Todas las validaciones actuales son locales y aisladas (`ISOLATED`).

## Estructura

- `g6-h5-integration.postman_collection.json`: Colección Postman v2.1.0 de solo lectura + casos negativos contractuales (38 casos `PM-*`, `followRedirects: false`, validación recursiva de esquemas OpenAPI `0.7.0-rc.3`, `safeSendRequest`, aislamiento dinámico de fixtures).
- `schemas/openapi-response-schemas.json`: Esquemas de respuesta verificados automáticamente contra `contratos/http/openapi.yaml` mediante Ajv (`ajv`, `ajv-formats`, `yaml`).
- `environments/`: Plantillas de entorno sin secretos (`apim.example.json`, `local.example.json`, `environment.example.json`).
- `scripts/`:
  - `validate-collection.mjs`: Validación estática de estructura, paridad OpenAPI `0.7.0-rc.3`, alineación de esquemas Ajv y escaneo anti-secretos.
  - `preflight.mjs`: Validación de origen permitido, HTTPS, perfiles y credenciales.
  - `run-newman.mjs` / `run-newman.ps1`: Runner parametrizado con sanitización por allowlist, reconciliación exacta `H11`, reportes JSON/JUnit/Markdown y manifiesto SHA-256.
  - `sanitize-evidence.mjs` / `generate-report.mjs`: Herramientas independientes de sanitización y regeneración de reportes.
- `tests/`: Suite automatizada con `node --test` cubriendo regresiones `H01`–`H15` y Defecto B (`PM-012` multi-ubicaciones).
- `package.json` / `package-lock.json`: Dependencias aisladas con versión exacta (`newman@6.2.3`, `ajv`, `ajv-formats`, `yaml`).

## Instalación y pruebas locales aisladas

```powershell
cd tests/h5/postman
npm ci
npm run validate
npm test
```

## Convención de estados y niveles de evidencia

| Etiqueta | Significado |
|---|---|
| `IMPLEMENTED` | Código, esquema o caso implementado y validado estáticamente. |
| `PASS / ISOLATED` | Validado localmente contra harness controlado (sin infraestructura Azure). |
| `FAIL / LAB_AZURE` | Defecto reproducido en corrida real previa contra APIM Chile (documentado en Docs). |
| `NOT_RUN` | Caso omitido explícitamente por falta de credencial (`BLOCKED_AUTH`) o fixture (`BLOCKED_FIXTURE`). |
| `STANDBY` | Validación en infraestructura real diferida hasta aprobación operativa. |

## Evidencias históricas y documentación H5

Las evidencias reales previas (`azure-preflight-2026-11-27`, `azure-apim-edge-2026-11-27`, `azure-apim-smoke-jws-2026-11-28`, `azure-apim-integration-jws-2026-11-28`), las matrices de cobertura y la traza downstream ACA (`catalog-svc -> pricing-svc`) se conservan íntegras en el repositorio de documentación (`G6-Productos-Ofertas-docs`, PR #154):

- `hitos/h5/demos-integracion-performance/postman/evidencias/`
- `hitos/h5/demos-integracion-performance/postman/matrices/`
