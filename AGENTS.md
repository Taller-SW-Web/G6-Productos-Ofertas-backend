# AGENTS.md — Instrucciones operativas para agentes en Backend

> **LEER COMPLETO ANTES DE EDITAR.** Este documento rige el desarrollo backend en el monorepo NestJS de **Productos y Ofertas (G6)**.

---

## 1. Orden obligatorio de trabajo

Prohibido escribir código antes de completar los pasos 1 a 5:

1. **LEER `AGENTS.md` COMPLETO** antes de editar cualquier archivo.
2. **Identificar la rama actual:** debe ser tu rama personal asignada.
3. **Leer el Issue asignado** y comprender todos sus criterios de aceptación.
4. **Identificar microservicio, owner y archivos autorizados:** verificar matriz de ownership.
5. **Consultar los contratos normativos correspondientes** en el repositorio de documentación.
6. **Realizar únicamente los cambios solicitados:** sin refactors extra ni archivos fuera de scope.
7. **Ejecutar pruebas:** pruebas enfocadas primero, luego validaciones generales.
8. **Revisar `git diff`:** verificar cambios exactos y ausencia de whitespace errors.
9. **Reportar resultados y bloqueos:** según el formato de reporte obligatorio.

---

## 2. Política definitiva de ramas

- **Ramas personales permanentes:**
  - `castilla`
  - `poma`
  - `cueva`
  - `lopez`
  - `vera`
  - `taco`
- Cada desarrollador trabaja y continúa trabajando exclusivamente en su rama personal.
- Puede implementar múltiples Issues y abrir sucesivos PRs hacia `master` desde ella.
- **PROHIBIDO:** crear ramas `feat/...`, `fix/...` o ramas nuevas automáticas.
- **PROHIBIDO:** sincronizaciones masivas automáticas desde `master`, `rebase`, `git push --force`, `git reset --hard` o merges destructivos.
- `infra/foundation` es una excepción temporal ya existente para la Foundation inicial (PR #2), **no** una convención para desarrolladores.
- Los PRs deben mantener alcance pequeño, atómico y específico.

---

## 3. Matriz de ownership de aplicaciones

| Rama | Aplicaciones propias autorizadas |
|---|---|
| `castilla` | `apps/bulk-svc`, `apps/combos-svc` |
| `poma` | `apps/catalog-svc` |
| `cueva` | `apps/promotions-svc` |
| `lopez` | `apps/taxonomy-svc` |
| `vera` | `apps/pricing-svc`, `apps/price-audit-svc` |
| `taco` | `apps/inventory-svc` |

- **`apps/api-gateway`:** componente transversal; NO debe ser modificado libremente. Requiere Issue explícito y coordinación con arquitectura e integración.
- **Archivos globales:** `libs/`, `.github/`, dependencias en `package.json`, scripts y configuración del monorepo (`nest-cli.json`, `tsconfig*.json`) son compartidos y requieren autorización expresa en el Issue.
- **Límite estricto:** un agente no puede modificar otra aplicación para resolver un problema de la propia.
- Si detectas necesidad de modificar archivos fuera de tu ownership, detén esa parte, repórtala como dependencia y continúa solo las partes autorizadas e independientes.

---

## 4. Fuentes normativas y reglas de negocio

- **Repositorio de documentación oficial:** [G6-Productos-Ofertas-docs](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs). Si no existe localmente en `../docs/`, consulta el repositorio oficial remoto. Rutas canónicas:
  - Arquitectura: `arquitectura/Arquitectura.md`
  - Contratos HTTP: `contratos/http/openapi.yaml`
  - Contratos Asíncronos: `contratos/eventos/asyncapi.yaml`
  - Especificaciones: `requisitos/specs/SPEC-*.md`
- **PROHIBIDO inventar contratos:** endpoints, campos, DTOs, eventos o códigos de error deben existir en OpenAPI/AsyncAPI oficiales.
- **PROHIBIDO mocks silenciosos:** no sustituir integraciones reales por arrays o datos simulados en producción.
- **PROHIBIDO alterar migraciones históricas:** las migraciones aplicadas en Supabase son inmutables.
- **PROHIBIDO compartir código entre servicios:** no importar entre `apps/*` ni compartir entidades ORM. Toda integración es vía contratos HTTP o eventos asíncronos.
- **Lógica de negocio:** no introducir lógica de negocio en `api-gateway` ni en librerías técnicas comunes.
- Si no puedes acceder al contrato normativo requerido, marca la tarea como `BLOCKED_CONTRACT` y repórtala; no inventes interfaces.

---

## 5. Protocolo para agentes de menor capacidad

1. Resolver una tarea concreta cada vez; no abarcar múltiples objetivos en paralelo.
2. Leer solo los archivos estrictamente necesarios para el cambio.
3. No reconstruir archivos completos si basta una edición localizada.
4. No realizar refactors adicionales ni actualizar dependencias sin autorización.
5. No eliminar ni comentar pruebas que fallen.
6. No solucionar errores de tipos con `any`, `@ts-ignore` ni desactivando reglas de lint/TypeScript.
7. Tras modificar código, ejecutar primero pruebas enfocadas del microservicio y luego validaciones aplicables:
   ```bash
   npm test               # pruebas unitarias
   npm run test:e2e       # pruebas e2e
   npm run typecheck      # verificación de tipos
   npm run lint           # linter
   ```
8. Si la misma corrección falla 2 veces consecutivas, detener esa línea de trabajo y reportar el error exacto.
9. No declarar `PASS` en un paso sin haber ejecutado el comando correspondiente.
10. No afirmar que una funcionalidad está implementada si solo existe un esqueleto/stub.
11. No hacer commit ni proponer cambios si existen errores obligatorios pendientes.

---

## 6. Reporte obligatorio al finalizar

Todo agente debe estructurar su respuesta final con:

```text
RAMA Y ISSUE: <rama> | <issue>
ARCHIVOS MODIFICADOS: <lista de rutas>
CAMBIOS REALIZADOS: <resumen conciso de cambios>
COMANDOS EJECUTADOS: <comando y resultado real: PASS/FAIL/NO EJECUTADO>
ERRORES PENDIENTES: <ninguno o detalle exacto>
CAMBIOS FUERA DEL ALCANCE: <ninguno o justificación expresa>
ESTADO FINAL: PASS / PARTIAL / BLOCKED
```
