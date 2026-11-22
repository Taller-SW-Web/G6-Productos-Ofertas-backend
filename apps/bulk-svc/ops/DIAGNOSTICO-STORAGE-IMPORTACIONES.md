# Diagnóstico de objetos privados de importación

El archivo se sube antes del commit SQL. El manejador no debe borrar objetos después de un error SQL: una conexión puede perderse luego de que PostgreSQL haya confirmado la admisión.

La siguiente consulta es de solo lectura. Ejecutarla en PostgreSQL descartable o mediante acceso de diagnóstico aprobado, con el `owner_sub`, `correlation_id` y `content_ref` obtenidos del contexto de la solicitud. No imprimir tokens ni bytes del archivo.

```sql
SELECT
  EXISTS (
    SELECT 1 FROM bulk.file_manifests fm
    WHERE fm.content_ref = :'content_ref'
  ) AS manifest_references_object,
  EXISTS (
    SELECT 1
    FROM bulk.batch_jobs bj
    JOIN bulk.file_manifests fm ON fm.id = bj.input_file_id
    WHERE bj.owner_sub = :'owner_sub'::uuid
      AND bj.correlation_id = :'correlation_id'::uuid
      AND fm.content_ref = :'content_ref'
  ) AS matching_admission_exists,
  EXISTS (
    SELECT 1 FROM bulk.inbox i
    WHERE i.message_id = (
      SELECT bj.batch_id::text
      FROM bulk.batch_jobs bj
      WHERE bj.owner_sub = :'owner_sub'::uuid
        AND bj.correlation_id = :'correlation_id'::uuid
      LIMIT 1
    )
      AND i.handler = 'bulk.import.admission'
  ) AS admission_receipt_exists;
```

## Interpretación conservadora

| Evidencia | Clasificación | Acción |
|---|---|---|
| Respuesta `202` y lote, manifest, Inbox visibles | Admisión confirmada | Conservar el objeto. |
| Rollback SQL confirmado y sin manifest/lote | Fallo SQL confirmado; objeto candidato sin referencia | Retener hasta poder probar que no existe una solicitud activa. |
| Timeout/desconexión con resultado SQL desconocido | Resultado ambiguo | Conciliar por `(owner_sub, correlation_id)`; no borrar. |
| El objeto privado existe, pero la consulta no encuentra manifest | Objeto sin manifest visible | Candidato huérfano; requiere inventario de Storage y ventana de inactividad acreditada. |
| Lote/manifest asociado a la correlación o solicitud todavía activa | Intención activa | Conservar y conciliar. |

Bulk no mantiene todavía un lease durable de cargas en curso ni una operación de inventario de objetos de Storage. Por tanto, una consulta negativa a PostgreSQL no prueba que no haya un POST activo ni habilita borrado automático. El cierre seguro requiere un protocolo de conciliación con enumeración privada del bucket, registro durable/lease de cargas y una prueba que excluya admisiones activas antes de borrar. Hasta entonces, la limpieza es manual, posterior a conciliación y permanece pendiente.
