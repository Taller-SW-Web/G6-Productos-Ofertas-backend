# Outbox H5 de Taxonomy

La versión propuesta es `../../migrations/0006_service_bus_outbox_delivery.sql`; la candidata `0001_outbox_delivery.sql` es referencia histórica y no debe aplicarse junto con ella. Aplicar 0006 únicamente como po_taxonomy_owner sobre su schema y mediante el proceso de datos autorizado. La migración añade un marcador a outbox y una tabla de entregas por destinatario. No genera un backfill. El marcador de filas históricas es RABBITMQ.

El runtime H5 usa MESSAGING_PROVIDER=AZURE_SERVICE_BUS y TAXONOMY_SERVICE_BUS_ENABLED=true. Al habilitar alguna dirección requiere SERVICE_BUS_NAMESPACE_FQDN y, en producción, identidad administrada; producción exige G7_AUTHENTICATED y habilitación general H5. Con ambas direcciones apagadas no requiere namespace ni identidad del broker, pero la selección Azure conserva la comprobación del almacenamiento H5. Deben estar ausentes RABBITMQ_URL y TAXONOMY_CATALOG_AMQP_USER. PostgreSQL recibe la opción de sesión g6.taxonomy_messaging. Se comprueba el marcador en la conexión real, la tabla y el trigger antes de exponer HTTP. Verificar compatibilidad con el pooler y con el rol runtime en el ambiente destino.

TAXONOMY_SERVICE_BUS_ENABLED=false pausa envío y consumo del runtime H5. La selección Azure continúa registrando los hechos nuevos con intención de entrega H5. Antes de cortar, detener réplicas con código anterior, reconciliar y drenar los pendientes H4, y probar el circuito completo con Catalog. Antes de volver a H4, conservar y conciliar las entregas H5 de forma independiente. El publicador H4 de esta versión solo reclama sus filas, incluso cuando ambos historiales permanecen en SQL.

Con la habilitación general en `true`, `TAXONOMY_SERVICE_BUS_SEND_ENABLED=true` habilita R18 y `TAXONOMY_SERVICE_BUS_RECEIVE_ENABLED=true` habilita R09. Ambas direcciones están apagadas cuando sus flags se omiten o son `false`; se rechaza activar una dirección mientras la habilitación general esté apagada. Las configuraciones existentes que solo establecen la habilitación general deben declarar cada dirección explícitamente antes de arrancarla. La selección del transporte de las filas sigue siendo Azure incluso al pausar el envío; las entregas permanecen pendientes. Aplicar el corte gradual únicamente con coordinación y reconciliación del owner.

Esta candidata es la variante seleccionada para la reconciliación R18/R09. La migración `0006_service_bus_outbox_delivery.sql` del PR #247 define una tabla incompatible y un trigger que encola también escrituras H4. Si aparece aplicada en un ambiente, revisar su ledger, estructura y pendientes con el owner antes de ejecutar esta candidata. El trabajo Bulk/claim-check del PR #243 conserva su revisión separada.

El flujo conserva orden causal por operación. Una entrega terminal sin envío queda pendiente de revisión y bloquea las siguientes de la misma operación. El resto continúa. Monitorizar edad del Outbox, DLQ y disponibilidad de enlaces.

[Orden de aplicación, esquema instalado y corte R18/R09](../../../../docs/hito-5/RECONCILIACION_R18_R09_PR258.md).

## Clasificación del corte (solo lectura)

Tras verificar el ledger, la estructura y los permisos con `preflight-readonly.sql`, el owner debe revisar cada fila histórica antes del corte. En un esquema que ya tenga instalada esta candidata, la siguiente consulta identifica la operación, el transporte y el estado de cada entrega sin generar envíos ni modificar datos:

```sql
BEGIN READ ONLY;
SELECT o.message_id, o.operation_id, o.event_name, o.occurred_at,
       o.delivery_transport,
       CASE WHEN o.delivery_transport = 'RABBITMQ' AND o.published_at IS NULL THEN 'PENDIENTE_H4'
            WHEN o.delivery_transport = 'RABBITMQ' THEN 'PUBLICADO_H4'
            WHEN d.message_id IS NULL THEN 'H5_SIN_DELIVERY_REVISAR'
            WHEN d.sent_at IS NULL THEN 'PENDIENTE_H5'
            ELSE 'PUBLICADO_H5' END AS clasificacion,
       d.destination, d.sent_at, d.last_error
FROM taxonomy.outbox o
LEFT JOIN taxonomy.outbox_delivery d ON d.message_id = o.message_id
ORDER BY o.occurred_at, o.message_id;
ROLLBACK;
```

Los pendientes H4 permanecen en H4 y no se convierten automáticamente en entregas Azure. El owner debe documentar por cada `message_id` la evidencia de entrega o el procedimiento de recuperación autorizado, con coordinación del consumidor; una fila no clasificada bloquea su corte. Ejecutar la consulta solo donde existan la candidata y los permisos de lectura correspondientes. El ensayo en PostgreSQL descartable no demuestra el estado del entorno compartido.

Para reproducir el ensayo H5, situar el repositorio Docs junto al Backend o indicar `G6_E2E_DOCS_PATH` apuntando a un checkout de Docs que contenga la versión contractual `0.7.0-rc.3`; ejecutar `node tests/h5/run-taxonomy-catalog-postgres.mjs`. La prueba carga el AsyncAPI de ese checkout y falla si la versión o la cola R18 difieren.

## Migración versionada propuesta: 0006

Ruta: `apps/taxonomy-svc/migrations/0006_service_bus_outbox_delivery.sql`. SHA-256 (bytes LF): `ab68c32c188ddbc6b75a07dfe7c5a6a3123d42711ed8bd344277e56b4f3f7f63`. No se ha aplicado en Supabase compartido. Ejecutar solo tras preflight de ledger, propietario, estructura y permisos; requiere una transacción completa. No reejecutar: los guards rechazan una instalación existente o alternativa y conservan sus filas. No hay backfill automático. La variante homónima del PR #247 es incompatible: si su ledger o estructuras existen, detener el despliegue y diseñar un upgrade preservando datos con el owner.

Reversión planificada, no automática: detener sender y receiver, reconciliar y drenar las entregas H5 con Catalog, respaldar y conservar outbox/delivery/inbox y evidencia de mensajes, y coordinar el corte con los owners. Solo después y bajo autorización de datos, el owner podrá retirar el trigger y función de H5, restricciones, tabla delivery y columna transport, verificando dependencias y ledger; restaurar H4 únicamente con reconciliación expresa. No ejecutar DROP ni modificar ledger en la base compartida desde este ensayo.
