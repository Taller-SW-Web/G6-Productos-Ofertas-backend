# Estado operativo actual de Oracle

**Observación:** 2026-10-19 22:32:52–22:36:19 UTC (17:32:52–17:36:19 Lima). Host `g6-po-vcn`. Auditoría SSH de solo lectura. Rama `castilla`, SHA de trabajo `9fb59128da489f4173e97739c3d27e459087ead2`; SHA actual de `master`: `9205eb455c4965a82ccb9fc4714cf976e4c059b0`.

Este resumen refleja solo las comprobaciones enumeradas en la [auditoría completa](auditorias/2026-10-19_22-32-52_UTC/RESUMEN.md). Los documentos del 17 de octubre siguen siendo evidencia histórica y no fueron reescritos.

## Lectura rápida

- **VM:** Ubuntu 24.04.5 LTS, kernel `7.0.0-1013-oracle`, 4 vCPU, 11 GiB RAM, 10 GiB disponibles, sin swap, 40 GiB libres en `/`; carga 0.12/0.15/0.15 y NTP sincronizado. No hay presión observada; capacidad para nueve servicios no está demostrada mediante carga o límites.
- **Contenedores:** Caddy, RabbitMQ, Gateway, Catalog, Pricing y Taxonomy están presentes; Gateway está `unhealthy`; hay cinco servicios G6 no desplegados.
- **HTTP:** HTTPS público llega a Caddy. `/api/v1/categorias` responde 200 vía Gateway. El handler de respaldo de Caddy responde 503 estático para rutas no configuradas.
- **RabbitMQ:** vhosts `g6-productos-ofertas` y `g6`; 4 exchanges de aplicación, 11 colas quorum y 57 bindings; 0 mensajes, 0 consumidores y 0 conexiones al corte. No se encontró infraestructura retry/DLX.
- **CI/CD:** las nueve filas de `services.psv` permiten selección manual; las nueve autorizaciones automáticas son `false`. Ejecutores remotos informan v4/registro v2 y sus checksums coinciden con `castilla`. Hay Deployments `success` para los cuatro servicios activos, pero eso no prueba readiness actual ni rollback ensayado.
- **Seguridad:** `runtime.env` existe para los nueve servicios, permisos `0640`; no se leyó ningún valor. Los cuatro contenedores HTTP observados montan la CA de PostgreSQL como solo lectura. Conectividad Supabase de Catalog/Pricing no está demostrada; Taxonomy da evidencia de readiness con consultas de lectura.
- **OCI:** NSG/Security Lists no consultadas. Desde el equipo auditor se alcanzaron TCP 22, 80 y 443; 3000 y 5672 expiraron. Esto no atribuye reglas concretas a OCI.

## Estado de los nueve componentes

| Servicio (puerto) | Desplegado / Docker health | Readiness observada | GET negocio / Gateway | SHA/tag | Estado operativo |
|---|---|---|---|---|---|
| `api-gateway` (3000) | Sí / `unhealthy` | Healthcheck falla: Catalog `not_ready`, Taxonomy `ready`, resto `not_configured`, cobertura `partial` | `/health` 200; `/api/v1/categorias` 200 por Gateway; productos/precios/promociones/combos 401 sin autenticación | `9205eb455c4965a82ccb9fc4714cf976e4c059b0` | `HEALTH_OK_READINESS_PENDIENTE` |
| `catalog-svc` (3001) | Sí / `healthy` | `/health/ready` 503; `/health/readiness` 404 | `/api/v1/productos` directo 400 sin parámetros; vía Gateway 401; no se confirma GET funcional | `9205eb455c4965a82ccb9fc4714cf976e4c059b0` | `HEALTH_OK_READINESS_PENDIENTE` |
| `pricing-svc` (3002) | Sí / `healthy` | `/health/ready` 200 | Sin GET de negocio exitoso ni acceso por Gateway demostrado | `2970df90babf2c8caa1849b179b02918fc74a005` | `HEALTH_OK_READINESS_PENDIENTE` |
| `price-audit-svc` (3003) | No | No aplica | Puerto no escucha; sin Gateway | — | `NO_DESPLEGADO` |
| `promotions-svc` (3004) | No | No aplica | Puerto no escucha; sin Gateway | — | `NO_DESPLEGADO` |
| `inventory-svc` (3005) | No | No aplica | Puerto no escucha; sin Gateway | — | `NO_DESPLEGADO` |
| `taxonomy-svc` (3006) | Sí / `healthy` | `/health/readiness` 200; `/health/ready` 200 | `GET /api/v1/categorias` 200 directo y por Gateway; readiness implementada con consultas PostgreSQL | `97ca576282e93e8b35f4bc33b5cbcb972e63caef` | `OPERATIVO_COMPROBADO` solo para lectura de categorías en el alcance observado |
| `combos-svc` (3007) | No | No aplica | Puerto no escucha; sin Gateway | — | `NO_DESPLEGADO` |
| `bulk-svc` (3008) | No | No aplica | Puerto no escucha; sin Gateway | — | `NO_DESPLEGADO` |

## Infraestructura transversal

| Componente | Confirmado | Pendiente / límite |
|---|---|---|
| Caddy 2.11.6 | Activo, `g6-edge`; puertos 80/443 globales; TLS Let's Encrypt YE1 válido hasta 2027-01-14; DNS `157.137.205.218`; Caddy → Gateway `/health` 200 | Sin healthcheck Docker; handler general responde 503; no todas las APIs tienen ruta pública |
| RabbitMQ 4.2.9-management | HEALTHY, volumen persistente, red privada, AMQP/Management solo loopback; vhost y usuarios/permisos presentes | Sin conexiones/consumidores; retry/DLX ausente; no se probaron clientes |
| `g6-edge` | Gateway y Caddy conectados | NSG OCI no observado |
| `g6-http` | Gateway, Catalog, Pricing y Taxonomy conectados | No se probó comunicación de cada par desde contenedores |
| Supabase CA | Host `0444`; montada en los cuatro servicios HTTP como bind ro | No se leyeron runtime values; Catalog/Pricing sin readiness satisfactoria/comprobación de negocio |

## Seguimiento

1. **P1:** resolver Catalog readiness 503 y Gateway unhealthy antes de declarar Gateway listo.
2. **P1:** reconciliar los nombres retry/DLX y su gate contractual antes de aprovisionar.
3. **P1:** completar los cinco servicios ausentes con SHA/CI, runtime, readiness y smoke de lectura por servicio; CD automático permanece desactivado.
4. **P2:** verificar integración de Pricing/Gateway, auth funcional, NSG/Security Lists OCI y rollback en ventana aprobada.
5. **P3:** evaluar límites de recursos/swap bajo carga representativa; este corte no mostró presión.

## Hito 4 — brecha de evidencia al 31 de octubre

- **CI/CD:** CI exitosa identificada para SHA de las cuatro imágenes activas; los Deployments GitHub reportan `success`. Falta demostrar readiness actual de Gateway/Catalog, rollback ejecutado y despliegue funcional de los cinco componentes ausentes. La publicación automática sigue apagada.
- **APIs:** hay una lectura de categorías comprobada por HTTPS/Gateway; respuestas sin autenticación en otras rutas no son smoke funcional. No se acredita el API de nueve componentes.
- **Demo funcional:** no se ejecutó ni se presume una demo E2E. La lectura de categorías es una prueba parcial, no evidencia de flujo comercial integrado.
- **Seguridad:** TLS y montajes CA/permissions están observados; el contenido/validez runtime se dejó intacto y por eso no fue verificado. Faltan NSG/Security Lists OCI, readiness de dependencias por servicio y autenticación E2E autorizada.

## Informe detallado

- [Resumen](auditorias/2026-10-19_22-32-52_UTC/RESUMEN.md) · [VM](auditorias/2026-10-19_22-32-52_UTC/INVENTARIO_VM.md) · [Contenedores y HTTP](auditorias/2026-10-19_22-32-52_UTC/CONTENEDORES_HTTP.md)
- [Redes y HTTPS](auditorias/2026-10-19_22-32-52_UTC/REDES_CADDY_HTTPS.md) · [RabbitMQ](auditorias/2026-10-19_22-32-52_UTC/RABBITMQ.md) · [CI/CD](auditorias/2026-10-19_22-32-52_UTC/CICD.md)
- [Seguridad](auditorias/2026-10-19_22-32-52_UTC/SEGURIDAD.md) · [Hallazgos](auditorias/2026-10-19_22-32-52_UTC/HALLAZGOS.md) · [Evidencias](auditorias/2026-10-19_22-32-52_UTC/EVIDENCIAS.md)
