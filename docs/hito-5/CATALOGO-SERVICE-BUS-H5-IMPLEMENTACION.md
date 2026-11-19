# Catalog — integración Service Bus H5

## Resumen y estado

Esta entrega conecta el runtime H5 local de `catalog-svc` con NestJS, valida mensajes recibidos y crea entregas H5 a partir del Outbox dentro de la transacción PostgreSQL. H4 RabbitMQ sigue siendo el modo predeterminado. No se migraron recursos compartidos ni se habilitó tráfico Azure.

| Capacidad | Estado |
|---|---|
| Runtime Nest, ciclo de vida y readiness H5 | IMPLEMENTADO; CI de tipo, build y E2E; Azure real pendiente |
| Receptor Peek-Lock e Inbox existente | IMPLEMENTADO; unitarias y E2E generales CI; Azure SDK/namespace real pendiente |
| Outbox de negocio + entregas por destino | IMPLEMENTADO en migración candidata; PostgreSQL 17 desechable CI aprobado |
| Relay con lease, token e ID estable | IMPLEMENTADO; rollback, fan-out, lease vencido y redelivery probados en PostgreSQL 17 CI |
| Baja de SKU vendible de producto simple | IMPLEMENTADO desde `catalog.sku_identity`; integración PostgreSQL incluida en CI |
| Bulk V1/V2 | Conservado y probado por el handler existente |
| Bulk V3 claim-check | IMPLEMENTADO por componentes; prueba endpoint/PostgreSQL aprobada; emisión sigue DESACTIVADA por defecto hasta verificar autorización y despliegue privado |
| Azure real, RBAC, homologación y despliegue | PENDIENTE_VERIFICACION; no se ejecutó despliegue |

Baseline de trabajo: Backend (implementación Catalog/Bulk) SHA c0cbf4df3e8355d6b958ac114966263d1e85f721; Docs master SHA 8355815eec26825edf7f5adac85b98638551b86e; contratos AsyncAPI/OpenAPI 0.7.0-rc.1 (SEMIFINAL_G6). La fuente Docs es el repositorio canónico. Los cambios locales preexistentes en scripts/seed/mcp/catalog/ y apps/catalog-svc/prod-ca-2021.crt se preservaron y no pertenecen a esta entrega.

## Arquitectura y selección de transporte

```text
Mutación Catalog
  └─ PostgreSQL transaction (negocio + Outbox)
       └─ trigger H5 condicionado por catalog.messaging_provider
            └─ outbox_delivery (message_id, destination)
                 └─ claim SKIP LOCKED + lease/token
                      └─ Service Bus Basic (fuera de la transacción)

Service Bus Peek-Lock
  └─ validar cuerpo, envelope y metadatos del broker
       └─ handlers Catalog + Inbox/efecto transaccional
            └─ commit PostgreSQL
                 └─ CompleteMessage
```

- Sin `MESSAGING_PROVIDER=AZURE_SERVICE_BUS`, se conserva H4 y el runtime H5 no se crea.
- H5 exige `SERVICE_BUS_NAMESPACE_FQDN` válido y usa `ManagedIdentityCredential`; no se proporciona namespace ni secreto ficticio.
- `CATALOG_H5_DESTINATIONS` es una allowlist de destinos salientes habilitados después de verificar cada consumidor; su valor predeterminado vacío no crea entregas de salida.
- H5 y AMQP son excluyentes. `CATALOG_AMQP_ENABLED=true` junto con H5 provoca error de configuración.
- En producción H5 también exige `G6_SECURITY_MODE=G7_AUTHENTICATED`.
- Nest crea los cuatro receivers al arrancar, inicia el relay y los cierra durante shutdown. Readiness falla si el runtime H5 seleccionado no está iniciado.
- El productor textual se valida contra la cola, pero no reemplaza RBAC/identidad del broker.

## Cobertura contractual Catalog

| Relación | Mensajes | Cola/handler Catalog | Estado local | Dependencia y gate |
|---|---|---|---|---|
| R01 Bulk → Catalog | `catalog.bulk.upsert.requested` | `g6.catalog.from.bulk` / `CatalogBulkService.consume` | V1/V2 conservados; V3 consume `content_ref` con identidad de servicio | Endpoint Bulk y Catalog cliente probados por componentes en PostgreSQL/E2E CI; falta verificar autorización y red privada del entorno; no emitir V3 aún |
| R04 Catalog → Bulk | catalog.bulk.upsert.completed, .rejected | g6.bulk.from.catalog / Outbox trigger y relay | Productor Catalog y entrega transaccional implementados; pruebas PostgreSQL CI | Consumer/Inbox Bulk, readiness, autorización y E2E de esta relación pendientes; flujo no está habilitado |
| R05 Catalog → Combos | catalog.product.deactivated, catalog.sku.deactivated | g6.combos.from.catalog | Productor y fan-out implementados; CI PostgreSQL | Consumer H5 Combos, RBAC y reconciliación pendientes; relación no habilitada |
| R06 Catalog → Inventory | catalog.sku.deactivated, inventory.sku.initialization.requested | g6.inventory.from.catalog | Productor implementado; integración PostgreSQL CI | Consumer H5 Inventory por mensaje, RBAC y aceptación de cola pendientes; relación no habilitada |
| R07 Catalog → Pricing | catalog.sku.deactivated, pricing.product.initialization.requested | g6.pricing.from.catalog | Productor implementado; integración PostgreSQL CI | Consumer H5 Pricing por mensaje, RBAC y aceptación de cola pendientes; relación no habilitada |
| R08 Catalog → Promotions | catalog.product.deactivated, catalog.sku.deactivated | g6.promotions.from.catalog | Productor y fan-out implementados; CI PostgreSQL | Consumer H5 Promotions, RBAC y aceptación de cola pendientes; relación no habilitada |
| R09 Catalog → Taxonomy | catalog.master.deactivation.checked | g6.taxonomy.from.catalog | Productor implementado; persistencia Outbox/relay validada en PostgreSQL | No confundir con E2E entrante R18; consumidor/handler Taxonomy, RBAC y prueba de esta relación pendientes |
| R11 Inventory → Catalog | inventory.sku.initialization.completed, .rejected | g6.catalog.from.inventory / CatalogMessageService.consume | Handlers de aplicación existentes | E2E aislado Taxonomy–Catalog no prueba Inventory→Catalog; productor/receiver H5 Inventory, autorización y prueba del flujo pendientes |
| R15 Pricing → Catalog | pricing.product.initialization.completed, .rejected | g6.catalog.from.pricing / CatalogMessageService.consume | Handlers de aplicación existentes | E2E Taxonomy–Catalog no prueba Pricing→Catalog; productor/receiver H5 Pricing, autorización y prueba del flujo pendientes |
| R18 Taxonomy → Catalog | seis eventos Taxonomy | g6.catalog.from.taxonomy / handlers Taxonomy/Master | Handlers conectados; CI E2E Taxonomy–Catalog PASS y persistencia PostgreSQL | Prueba aislada, no Azure Service Bus real; productores/identidad y activación por ambiente pendientes |

`catalog.product.deactivated` y `catalog.sku.deactivated` se guardan juntos cuando un producto simple se da de baja. El SKU vendible se obtiene de `catalog.sku_identity`; no se copia `sku_base`. Para variantes, solo se emite el SKU cambiado y el evento de producto solo si el padre transiciona.

## Persistencia y recuperación

La migración candidata `apps/catalog-svc/migrations-candidate/h5/0001_outbox_delivery.sql` crea la entrega por destinatario, índice parcial y trigger `catalog.enqueue_h5_outbox_deliveries`. El trigger crea las filas solo cuando la transacción ejecuta con proveedor H5; los Outbox históricos H4 no generan entregas. El par `(message_id, destination)` es único.

El relay reclama una fila con `FOR UPDATE SKIP LOCKED`, establece lease y token, publica fuera de la transacción y confirma solo si conserva el token. Cada intento y destino son independientes; un timeout conserva la identidad del mensaje. El receiver completa después del commit del handler. Mensajes malformados/permanentemente inválidos se envían a DLQ; excepciones de persistencia se abandonan para redelivery. Inbox, operaciones obsoletas y resultados terminales usan la lógica de Catalog ya existente.

No ejecutar esta migración en Supabase compartido desde esta entrega. El archivo permanece como candidata y requiere el preflight, autorización y procedimiento de despliegue aprobados.

## Bulk V3 claim-check

AsyncAPI `0.7.0-rc.1` mantiene V1/V2 y define V3 con `batch_id`, `batch_operation_id`, `template_version=2`, `mode` y `content_ref`; las filas no viajan en el mensaje. El builder de Bulk produce un único comando V3 por lote. El documento JSON y su metadato (`content_id`, ruta privada, SHA-256, longitud y tipo) se guardan desde Bulk. La migración `apps/bulk-svc/migrations/0004_catalog_claim_check_content.sql` deja la referencia física en el schema `bulk`; Catalog solo recibe el UUID opaco.

Bulk implementa `GET /interno/carga-masiva/contenidos/{contentId}`. El endpoint exige JWT de servicio RS256, issuer G7 configurado, `tipo=servicio`, audiencia `api-productos`, `scope=carga-masiva:contenidos:leer` y cliente `catalog-svc`. Devuelve los bytes almacenados, `Content-Length` y `X-Content-SHA256`, sin serializar de nuevo el JSON. En producción, la URL debe resolverse por ingress privado; no se agrega al Gateway/APIM. El test de integración usa PostgreSQL desechable y Storage local de prueba, no un servicio Azure/Supabase real.

Catalog solicita el token con cliente `catalog-svc` y el scope indicado; valida el `content-type`, longitud contractual, límite defensivo de 50 MiB, longitud de los bytes recibidos, digest declarado y SHA-256 recalculado. Usa UTF-8 estricto y JSON antes de pasar filas al motor bulk e Inbox existente. Reintenta hasta tres veces fallas de red y respuestas transitorias 429/5xx; no reintenta respuestas de autorización ni de recurso ausente. No se incorporan credenciales de Storage en Catalog.

La emisión V3 está DESACTIVADA por defecto: requiere simultáneamente `BULK_CATALOG_V3_ENABLED=true` y `BULK_CATALOG_V3_AUTHORIZATION_VERIFIED=true`. El segundo flag no demuestra que una identidad, ingress privado, scope y grant estén configurados en un ambiente; no establecer ambos en un despliegue hasta validar esos controles y el consumidor Catalog. No se considera homologado el flujo de extremo a extremo Bulk→Azure Service Bus→Catalog para V3.

## Cuerpo recibido y seguridad

El receptor admite `Uint8Array` (incluido Buffer), cadena JSON y objeto JSON decodificado, verifica UTF-8/JSON y limita el cuerpo a 256 KiB. Valida `contentType`, envelope, identidad de productor permitida por cola y coincidencia de `messageId`, `correlationId` y `subject`. Los campos top-level `causation_id` y `operation_id` opcionales se aceptan ausentes o `null`; cuando están presentes se validan según AsyncAPI y las reglas más estrictas de cada evento. El E2E del SDK de Azure y namespace reales continúa pendiente.

## Pruebas y evidencia

| Prueba | Comando | Resultado en esta entrega | Ambiente/límite |
|---|---|---|---|
| Unitarias Backend | npm run test:unit | PASS: 226 archivos, 2 omitidos; 2.649 pruebas aprobadas, 73 omitidas | GitHub Actions run 44540453944; Backend SHA c0cbf4df3e8355d6b958ac114966263d1e85f721 |
| TypeScript/build/lint/contracts | CI principal | PASS | GitHub Actions run 44540453944; Backend SHA c0cbf4df3e8355d6b958ac114966263d1e85f721 |
| Formato requerido | npm run format:check | PASS | GitHub Actions run 44540453944; Backend SHA c0cbf4df3e8355d6b958ac114966263d1e85f721 |
| CI Backend principal | Workflow ci.yml manual | Todos los jobs obligatorios PASS: unitarias, typecheck, lint, formato, build, contratos, E2E, PostgreSQL, Taxonomy–Catalog e imágenes; benchmark opt-in omitido | [Run 44540453944](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/44540453944); Backend SHA c0cbf4df3e8355d6b958ac114966263d1e85f721 |
| E2E Taxonomy–Catalog, barrera BRAND | Job Probar E2E aislado Taxonomy y Catalog | PASS; suite completa y barrera BRAND correlacionada. La causa del timeout fue rechazar causation_id ausente, opcional por AsyncAPI; parser corregido sin debilitar validaciones de eventos | Run 44540453944, job 135617061351; PostgreSQL/RabbitMQ de prueba, sin Azure real |
| Persistencia/relay Catalog PostgreSQL 17 | apps/catalog-svc/test/postgres.persistence.e2e-spec.ts | PASS (100 pruebas PostgreSQL), incluye migración/relay | Run 44540453944, job E2E 135617060323; PostgreSQL 17 Docker desechable |
| Atomicidad, rollback, fan-out, caída tras claim, lease vencido, redelivery y recuperación | Caso H5 real PostgreSQL migration en postgres.persistence.e2e-spec.ts | PASS en PostgreSQL real; no mocks para base, trigger ni relay | Run 44540453944, job E2E 135617060323 |
| Bulk V3 endpoint + persistencia | apps/bulk-svc/test/bulk-postgres-outage.e2e-spec.ts y casos de integridad Catalog/Bulk | PASS en CI: bytes, Content-Length, SHA-256, identidad y hash/longitud incorrectos cubiertos | Run 44540453944, Backend SHA c0cbf4d; Storage de prueba, no Azure/Supabase real |
| Bulk relay contra PostgreSQL y RabbitMQ descartables | workflow Bulk H4 integration | PASS (16 pruebas) | [Run 44537744565](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/44537744565); código Bulk SHA e55009e51542dccb958a635a5406c34a6016cd7e; no es Azure real |
| Azure Service Bus, Managed Identity y RBAC de ambiente | No ejecutada | PENDIENTE_VERIFICACION | No se proporcionó namespace ni ambiente autorizado; Bulk V3 sigue desactivado |

El run CI automático asociado a la Draft omitió jobs; por eso se ejecutó CI manual completo en el SHA de código c0cbf4df3e8355d6b958ac114966263d1e85f721. La integración Bulk/PostgreSQL/RabbitMQ del SHA e55009e51542dccb958a635a5406c34a6016cd7e valida esa implementación; CI posterior en c0cbf4d añade las pruebas explícitas de integridad. La suite local completa no se toma como evidencia: falló por ausencia de OpenSSL/Docker y bloqueo de loopback; CI con PostgreSQL real sí pasó. Azure real, homologación, RBAC de despliegue y despliegue no se probaron.

## Preflight, habilitación y reversión

1. Verificar disponibilidad de los cuatro productores/consumidores por relación, colas preaprovisionadas, RBAC por identidad y límites Basic.
2. Aplicar la migración candidata mediante el procedimiento aprobado y comprobar permisos/readiness.
3. Ejecutar pruebas PostgreSQL de inserción atómica, fan-out, redelivery, lease vencido y confirmación tardía.
4. Desplegar con `MESSAGING_PROVIDER=RABBITMQ` (default histórico) hasta que exista aprobación explícita por flujo.
5. Habilitar H5 en un ambiente controlado con `SERVICE_BUS_NAMESPACE_FQDN`, identidad administrada autorizada y `G6_SECURITY_MODE=G7_AUTHENTICATED`; correr smoke, revisar backlog/DLQ y conciliar Inbox/Outbox.
6. Para revertir, detener escrituras/relay H5, conciliar cada `(message_id,destination)` con estado terminal del consumidor y reactivar H4 solo después de decidir los pendientes. No publicar por ambos brokers ni reenviar Outbox histórico H4 automáticamente.

La habilitación productiva permanece bloqueada por homologación/identidad Azure, y por los consumidores indicados en la matriz. No se ejecutó despliegue ni migración compartida.
