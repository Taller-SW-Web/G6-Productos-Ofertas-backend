# Ficha — combos-svc

## A. Identidad

Owner Castilla; rama personal `castilla`. Puerto 3007 / `COMBOS_SVC_PORT`. Schema/DB/Rabbit: no declarados en scaffold actual. Proyecto/contenedor `g6-combos-svc`, generic Compose, runtime `/etc/g6-combos-svc/runtime.env`, estado `/var/lib/g6-productos-ofertas/combos-svc`. Oracle 19-oct no desplegado. Código master ref `9205eb455c4965a82ccb9fc4714cf976e4c059b0`; branch actual `castilla` al SHA de trabajo. Controladores actuales solo health scaffold, no endpoints de negocio asumidos.

## B. Configuración runtime

Compose inyecta `NODE_ENV=production`, `PORT=3007`, `COMBOS_SVC_PORT=3007`. Consumidor en `apps/combos-svc/src/main.ts`; schema adicional, credentials, JWT/AMQP vars no constan y no deben inventarse. env_file privado queda preparado en registro, no prueba que necesite secretos.

## C. Dependencias

Puerto loopback, overlay de `g6-http` al preparar. Sin DB/Rabbit/upstream demostrado. OpenAPI describe interfaces de combos; su uso requiere implementación/contrato antes de declarar dependencia.

## D. HTTP / seguridad

OpenAPI oficial rc.1 tag Combos aplica a negocio; scaffold master no implementa rutas contractuales según inspección. `/health` liveness, readiness business y auth pendientes por implementar desde el contrato. No configurar Gateway URL hasta endpoint funcional.

## E. RabbitMQ

No AMQP en scaffold actual. Oracle incluye `po.combos.q` y usuario físico `g6_combos` read-only; eso no convierte al servicio en consumidor ya implementado. Comparar AsyncAPI si branch incorpora eventos; sin retry/DLX.

## F. Persistencia

Sin tablas/schema/migraciones configurados. Castilla debe leer DEC-F y OpenAPI; adoptar persistencia solo cuando aprobada/especificada. No migrar al arranque.

## G. Pruebas y aceptación

`npm run build:combos-svc`; `npm test -- apps/combos-svc`; `npm run test:e2e -- apps/combos-svc`; `npm run typecheck`; `npm run lint`; `bash ops/oracle/build-service.sh combos-svc`; image/Compose generic. DB/Rabbit integration command específica no existe/consta: crear cuando implementación y contratos lo justifiquen. CI compila/build y generic health smoke, no business behavior.

## H. Bloqueos y entrega

Castilla: implementar el alcance contractual del issue con datos/dependencias reales aislados y readiness pertinente; indicar qué APIs faltan frente OpenAPI. Marco: crear runtime values si necesarios, autorizar red/upstreams y deployment. No marcar listo por `/health`.
