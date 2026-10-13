# AGENTS.md — Instrucciones obligatorias para cualquier agente en Backend

> **LEER COMPLETO ANTES DE EDITAR.** Este repositorio alberga el backend oficial del módulo **Productos y Ofertas (G6)** mediante un monorepo NestJS con TypeScript y npm.

---

## 1. Arquitectura y Estructura del Monorepo

- **Modo Monorepo NestJS:** Todas las aplicaciones residen en `apps/`.
- **Microservicios confirmados (8 bounded contexts + 1 API Gateway/BFF):**
  - `apps/api-gateway/`: Entrada/BFF, enrutamiento, agregación de lecturas (NO contiene lógica de negocio pesada).
  - `apps/catalog-svc/`: Productos, variantes, SKU, atributos, imágenes, estados, slug y perfil físico por SKU.
  - `apps/pricing-svc/`: Precios regulares/oferta, vigencias, canal, versión y programación.
  - `apps/price-audit-svc/`: Auditoría de precios (append-only, exportación y archivo).
  - `apps/promotions-svc/`: Promociones, cupones, consumo de cupón, cross-sell y upsell.
  - `apps/inventory-svc/`: Saldos, reservas, consumo, liberación, ajustes, incidencias, Kardex y dashboard.
  - `apps/taxonomy-svc/`: Categorías, marcas, características, tipos de producto y SEO de taxonomía.
  - `apps/combos-svc/`: Definición, composición, precio y disponibilidad proyectada de combos.
  - `apps/bulk-svc/`: Importación/exportación, validación, coordinación por fila y reintentos.
- **Librerías compartidas (`libs/`):**
  - Se crean exclusivamente mediante `nest generate library <name>`.
  - `libs/contracts/`: Contratos de intercambio (DTOs OpenAPI, schemas AsyncAPI, types). No contiene lógica de negocio.
  - `libs/platform/`: Utilidades transversales (config, auth guards, problem-details).
  - **PROHIBIDO:** importar código directamente entre aplicaciones (`apps/* -> apps/*`). Toda comunicación interservicio es mediante contratos HTTP o eventos asíncronos.

---

## 2. Fuentes de Verdad y Orden de Precedencia

1. **Documentación Normativa (`../docs/`):**
   - Arquitectura oficial: `docs/arquitectura/Arquitectura.md`.
   - Contratos HTTP: `docs/contratos/http/openapi.yaml`.
   - Contratos Asíncronos: `docs/contratos/eventos/asyncapi.yaml`.
   - Reglas de negocio: `docs/requisitos/specs/SPEC-*.md` y `HU-*.md`.
2. **Repositorio de docs:** Se consulta **solo para lectura**. No modificar el repositorio `docs/` desde el backend.
3. **Repositorio de backend:** Solo modificar código dentro de `backend/`.

---

## 3. Reglas de Negocio, Contratos y Datos

- **PROHIBIDO inventar contratos:** No crear endpoints, rutas HTTP, métodos, eventos, payloads ni DTOs no definidos en los contratos aprobados en `docs/`.
- **PROHIBIDO mocks silenciosos:** No implementar respuestas simuladas en producción ni sustituir integraciones reales con arrays hardcodeados presentados como funcionales.
- **PROHIBIDO alterar migraciones ejecutadas:** Las migraciones de Supabase/PostgreSQL ya aplicadas no se modifican; los cambios se realizan mediante nuevas migraciones incrementales.
- **Separación de responsabilidades:**
  - `CREADO` no equivale a `APTO_PARA_PAGO`.
  - `barcode` no es `sku`.
  - `productId` no es `sku`.
  - El inventario y stock pertenecen a `inventory-svc`, no a ventas ni catálogo.
  - El actor humano canónico es el **Gestor Comercial** (`GESTOR_COMERCIAL`). No inventar roles globales de usuario.

---

## 4. Comandos de Validación Obligatorios

Antes de proponer o entregar cualquier cambio, ejecuta y verifica:

```powershell
# 1. Instalación reproducible
npm ci

# 2. Verificación estricta de TypeScript
npm run typecheck

# 3. Análisis estático (linter)
npm run lint

# 4. Pruebas unitarias
npm test

# 5. Pruebas end-to-end (health endpoints)
npm run test:e2e

# 6. Compilación de aplicaciones
npm run build:all
# O individual: npm run build:<app-name>
```

---

## 5. Reglas de Git y Flujo de Trabajo

- La rama `master` está protegida y exige Pull Request y revisión aprobada.
- No hacer push directo a `master`.
- Usar ramas temáticas según convención: `feat/...`, `fix/...`, `infra/...`.
- No usar `git push --force`, `git reset --hard` ni `git clean -fd`.
- Verificar siempre `git diff --check` para prevenir espacios en blanco o problemas de fin de línea.
