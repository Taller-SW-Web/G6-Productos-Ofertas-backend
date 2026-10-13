# Guía de Contribución al Backend (G6 — Productos y Ofertas)

Esta guía establece el flujo de trabajo para desarrolladores y agentes de IA en el backend monorepo NestJS.

---

## 1. Lectura Obligatoria

Antes de comenzar cualquier desarrollo, es imperativo leer:
- [AGENTS.md](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/blob/master/AGENTS.md): Normas operativas, matriz de ownership, prohibiciones y protocolo para agentes.

---

## 2. Flujo de Trabajo

El flujo estándar de entrega es:

```text
Issue asignado → Rama personal permanente → Implementación localizada → Pruebas locales → PR hacia master → Aprobación
```

1. **Revisar el Issue:** Verificar criterios de aceptación y microservicio asignado.
2. **Posicionarse en la rama personal:** Trabajar exclusivamente en la rama correspondiente (`castilla`, `poma`, `cueva`, `lopez`, `vera` o `taco`). No crear ramas por feature (`feat/...`, `fix/...`).
3. **Consultar contratos normativos:** Verificar las especificaciones y contratos oficiales en el repositorio [G6-Productos-Ofertas-docs](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs).
4. **Implementación y pruebas:** Realizar únicamente cambios dentro del microservicio asignado. Prohibido modificar aplicaciones ajenas.
5. **Ejecutar validaciones:**
   ```bash
   npm test          # Pruebas unitarias
   npm run test:e2e  # Pruebas e2e
   npm run typecheck # Verificación TypeScript
   npm run lint      # Análisis estático
   ```
6. **Abrir Pull Request:** Abrir PR hacia `master` desde tu rama personal con alcance pequeño y atómico. La rama `master` exige PR y revisión obligatoria para merge.

---

## 3. Responsabilidad

- Cada desarrollador es plenamente responsable del código, commits y Pull Requests generados en su rama, incluidos los producidos por asistentes o agentes de IA.
- Todas las pruebas deben ser ejecutadas efectivamente antes de reportar o abrir un PR. Si algún comando no fue ejecutado, debe informarse explícitamente como `NO EJECUTADO`.
