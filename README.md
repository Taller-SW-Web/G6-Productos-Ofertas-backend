# G6 — Productos y Ofertas (Backend Monorepo)

Monorepo NestJS oficial con TypeScript y npm para el backend de **Productos y Ofertas (G6)**.

Repositorio de documentación normativa: [G6-Productos-Ofertas-docs](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs)

---

## 1. Requisitos de Entorno

- **Node.js:** `>= 22.0.0` (recomendado Node 22 LTS o 24)
- **npm:** `>= 10.0.0`
- **TypeScript:** `6.x`

---

## 2. Instalación

Instalación limpia y reproducible desde `package-lock.json`:

```bash
npm ci
```

---

## 3. Microservicios del Monorepo

El monorepo organiza las aplicaciones bajo el directorio `apps/`, correspondiendo a los bounded contexts aprobados en la arquitectura oficial:

| Aplicación | Puerto por defecto | Variable de Entorno | Responsabilidad |
|---|---|---|---|
| `api-gateway` | `3000` | `API_GATEWAY_PORT` | Entrada/BFF, enrutamiento, agregación de lecturas |
| `catalog-svc` | `3001` | `CATALOG_SVC_PORT` | Productos, variantes, SKU, atributos, imágenes, estados |
| `pricing-svc` | `3002` | `PRICING_SVC_PORT` | Precios regulares/oferta, vigencias, canal, versiones |
| `price-audit-svc` | `3003` | `PRICE_AUDIT_SVC_PORT` | Auditoría de precios, registro append-only, exportación |
| `promotions-svc` | `3004` | `PROMOTIONS_SVC_PORT` | Promociones, cupones, cross-sell y upsell |
| `inventory-svc` | `3005` | `INVENTORY_SVC_PORT` | Saldos, reservas, consumo, liberación, ajustes, Kardex |
| `taxonomy-svc` | `3006` | `TAXONOMY_SVC_PORT` | Categorías, marcas, características, tipos y SEO |
| `combos-svc` | `3007` | `COMBOS_SVC_PORT` | Definición, composición y proyección de combos |
| `bulk-svc` | `3008` | `BULK_SVC_PORT` | Importación y exportación masiva, validación por fila |

---

## 4. Endpoints de Salud (`/health`)

Cada microservicio expone un endpoint HTTP de verificación de arranque:

```http
GET /health
```

Respuesta JSON estándar:
```json
{
  "status": "ok",
  "service": "<app-name>"
}
```

---

## 5. Scripts de Ejecución y Desarrollo

### Iniciar microservicios localmente

```bash
# Iniciar microservicio específico en modo watch
npm run start:api-gateway
npm run start:catalog-svc
npm run start:pricing-svc
npm run start:price-audit-svc
npm run start:promotions-svc
npm run start:inventory-svc
npm run start:taxonomy-svc
npm run start:combos-svc
npm run start:bulk-svc
```

### Compilación

```bash
# Compilación general de todo el monorepo
npm run build:all

# O compilar un microservicio individual
npm run build:catalog-svc
npm run build:api-gateway
```

### Calidad de Código y Pruebas

```bash
# Verificación de tipos TypeScript estricto
npm run typecheck

# Linter rápido (oxlint)
npm run lint

# Formato con Prettier
npm run format

# Pruebas unitarias (Vitest)
npm test

# Pruebas e2e / health endpoints (Vitest)
npm run test:e2e
```

---

## 6. Variables de Entorno

Copiar `.env.example` a `.env` para personalizar puertos y configuraciones locales:

```bash
cp .env.example .env
```

---

## 7. Flujo de Trabajo y Contribución

1. **Ramas:** No trabajar sobre `master`. Crear ramas descriptivas (`feat/...`, `fix/...`, `infra/...`).
2. **Validación previa:** Asegurar que `npm ci`, `npm run typecheck`, `npm run lint` y `npm test` pasen exitosamente.
3. **Pull Requests:** Todos los cambios a `master` deben pasar por PR y revisión técnica.
4. **Instrucciones para agentes:** Consultar [AGENTS.md](./AGENTS.md) antes de realizar ediciones automáticas.
