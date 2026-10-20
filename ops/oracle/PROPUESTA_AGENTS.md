# Propuesta de cambio mínimo para `AGENTS.md` (pendiente de autorización transversal)

La sección 3 de `AGENTS.md` establece que los archivos globales requieren autorización expresa en el Issue. Este encargo no identifica un Issue transversal que autorice editar el archivo compartido. Por ello, este parche queda preparado para revisión y no se aplica aquí.

```diff
 Antes de editar código de una aplicación, identifica su owner en la matriz de ownership.
 Los cambios quedan limitados a la aplicación asignada, sus pruebas y documentación propia.
+ Antes de implementar o modificar un microservicio, consulta `AGENTS.md`, los contratos
+ OpenAPI/AsyncAPI y decisiones aplicables, `ops/oracle/GUIA_DEVTEAM.md`,
+ `ops/oracle/CONTRATO_DESPLIEGUE.md`, `ops/oracle/servicios/<nombre-del-servicio>.md`,
+ `ops/oracle/MATRIZ_DEPENDENCIAS.md`, `ops/oracle/RABBITMQ_COMPATIBILIDAD.md` cuando
+ corresponda y `ops/oracle/CHECKLIST_PREDEPLOY.md`.
+ Un microservicio no es READY_FOR_DEPLOY hasta demostrar compatibilidad con Docker
+ Compose, puertos, runtime, Supabase, RabbitMQ, seguridad, contratos, health y readiness,
+ con evidencia aplicable al SHA candidato. Un bloqueo RabbitMQ no impide desarrollar
+ operaciones HTTP o persistencia independientes dentro del alcance autorizado.
```

El parche no cambia ramas, ownership, DEC-F ni contratos. Falta un Issue transversal explícito y la autorización que pide la sección 3. No afirmar la adopción antes de integrar el cambio real.
