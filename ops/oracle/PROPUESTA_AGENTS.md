# Propuesta mínima para `AGENTS.md` (pendiente de aprobación)

`AGENTS.md` es compartido y no se edita en este alcance. El encargo no incluye un Issue transversal ni autorización de Marco para cambiarlo. Propuesta mínima para revisión:

```diff
 Antes de editar código de una aplicación, identifica su owner en la matriz de ownership.
 Los cambios quedan limitados a la aplicación asignada, sus pruebas y documentación propia.
+ Antes de implementar, lee `ops/oracle/CONTRATO_DESPLIEGUE.md` y la ficha correspondiente
+ de `ops/oracle/servicios/`; usa `ops/oracle/GUIA_DEVTEAM.md` como procedimiento de trabajo.
+ Si una dependencia externa no está disponible, prueba con infraestructura real aislada,
+ registra el bloqueo y no sustituyas la dependencia por un mock silencioso en producción.
```

Alcance de la propuesta: añadir tres líneas operativas sin cambiar ownership ni gobernanza de contratos. Aplicar solo mediante issue transversal y aprobación correspondiente.
