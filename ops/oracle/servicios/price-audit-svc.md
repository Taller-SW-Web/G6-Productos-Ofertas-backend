# Ficha — price-audit-svc

## A. Identidad

Owner Vera; rama `vera` (`3071a1a5687f4bdcf78cc7e561aa91e4e2550483` snapshot consultado). Puerto 3003 / `PRICE_AUDIT_SVC_PORT`. Schema: no determinado en implementación actual; no inventar. Proyecto/contenedor `g6-price-audit-svc`; generic Compose; `/etc/g6-price-audit-svc/runtime.env`; estado `/var/lib/g6-productos-ofertas/price-audit-svc`. Oracle 19-oct: no desplegado. master SHA ref `9205eb455c4965a82ccb9fc4714cf976e4c059b0`; servicio actual scaffold/health sin evidencia de persistencia ni endpoints de negocio; rama personal a validar.

## B. Configuración runtime

| Variable | Estado | Consumidor / validación |
|---|---|---|
| `NODE_ENV`,`PORT`,`PRICE_AUDIT_SVC_PORT` | Compose injecta production/3003/alias port; requerida | `apps/price-audit-svc/src/main.ts`; specific port precede PORT (confirmar código del SHA) |
| Variables PostgreSQL / AMQP / auth | No consta configuración en master scaffold consultado | No añadir hasta Issue, contrato y parser reales. Compose monta CA ro aunque no prueba uso DB. |

## C. Dependencias

Puerto loopback 3003; CD usa generic Compose y CA. `g6-http` se prepara con overlay; al corte no desplegado. La dependencia de auditoría derivada del dominio puede ser parte del contrato OpenAPI/DEC-F, pero no significa que DB/broker estén configurados. Sin AMQP probado.

## D. HTTP / seguridad

OpenAPI docs origin/master SHA `c36bd9a...` version `0.6.0-rc.1` tiene paths bajo tag Auditoría de precios; la implementación master observada solo health controller. No afirmar endpoints de negocio implementados sin revisión SHA/route map. `/health` solo liveness, readiness funcional pendiente. JWT/scopes según OpenAPI, no improvisar.

## E. RabbitMQ

Oracle queue `po.auditoria-precios.q`, usuario `g6_auditoria_precios` físicamente read-only; esto no demuestra que servicio deba ser consumidor ni autorización. AsyncAPI y DEC-F gobiernan evento requerido. No se identificó publisher/consumer en scaffold. Sin retry/DLX.

## F. Persistencia

Tablas, schema, rol, migraciones, política append-only y pruebas PostgreSQL deben ser especificados por contrato/decisión y owner antes de implementación. Ningún DDL en arranque.

## G. Pruebas y aceptación

Comandos existentes: `npm run build:price-audit-svc`, `npm test -- apps/price-audit-svc`, `npm run test:e2e -- apps/price-audit-svc`, `npm run typecheck`, `npm run lint`, `bash ops/oracle/build-service.sh price-audit-svc`; integración DB/AMQP específica no identificada: **pendiente de implementar con contrato**. Imagen genérica + Compose, readiness y rutas una vez hechas.

## H. Bloqueos y entrega

Vera/owner contractual: fijar alcance de persistencia/retención/API conforme DEC-F/OpenAPI; implementar readiness con dependencia real, pruebas de append-only e integración aislada. Marco debe provisionar credenciales/schema y autorizar release individual; ninguna operación financiera/audit write en Oracle para smoke.
