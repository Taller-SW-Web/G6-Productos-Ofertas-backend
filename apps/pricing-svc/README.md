# pricing-svc — estructura y configuración (#52)

Owner: Leonardo Vera, rama `vera`. Alcance operativo: `IMPLEMENTAR_AHORA`.

## Configuración y ejecución

Se conservan los scripts del monorepo: `npm run build:pricing-svc`,
`npm run start:pricing-svc` y `npm run start:dev:pricing-svc`.
Usar la versión de Node indicada en `package.json`. El ejecutable carga `.env`
de la raíz si existe; las variables de la sesión tienen precedencia.

| Variable | Descripción | Obligatoria |
|---|---|---|
| `NODE_ENV` | Entorno: `development`, `test` o `production`. | Sí |
| `PRICING_SVC_PORT` | Puerto HTTP entero entre 1 y 65535; prioridad sobre `PORT`. Puerto asignado a Pricing: 3002. | Sí, salvo que exista `PORT` |
| `PORT` | Alternativa cuando no se define el puerto propio. No sustituye un puerto propio inválido. | Condicional |
| `DATABASE_URL` | Conexión PostgreSQL directa/pooler para el rol runtime de Pricing, con host, usuario y base. Inyectar desde la sesión o gestor de secretos. | Sí |

No hay valores implícitos para variables obligatorias. Configuración ausente o
malformada impide crear Nest/abrir el listener y termina con código 1. No se
imprime el valor rechazado. Los errores al cargar `.env` o abrir el listener
también se informan con un mensaje fijo sin el error original.
TLS y certificados corresponden a la conexión provisionada; no se deshabilita
su verificación en código. No usar credenciales owner/deployer, claves del
frontend ni acceso a schemas ajenos. No se cambia exposición de puertos.

## Sondas operativas

| Ruta | Significado | Resultado |
|---|---|---|
| `GET /health` | Liveness existente, preservado para infraestructura. | 200, `status=ok` |
| `GET /health/live` | Liveness de Arquitectura §25; no consulta dependencias. | 200, `status=ok` |
| `GET /health/ready` | Disponibilidad de PostgreSQL y lectura de `pricing.prices`. | 200, `status=ready`; 503, `status=not_ready` |

Todas las respuestas identifican `service=pricing-svc`. Readiness ejecuta
`SELECT 1 FROM pricing.prices LIMIT 0`: comprueba conexión y acceso a una tabla
propia, sin leer filas ni escribir datos. Una base caída, schema/tabla ausente
o permisos insuficientes produce 503; liveness sigue en 200. No acredita todas
las tablas, grants de escritura ni funcionalidades de precios.
El pool limita conexiones a 2 y tiempos de conexión/consulta a 2 segundos
cada uno; se libera al cerrar la aplicación y en señales de apagado de Nest.
No hace fan-out a otros servicios. Broker no es dependencia de este scaffold:
no hay consumers, relay ni operaciones de negocio implementados en #52.

## Logging y fuentes

Logs JSON con servicio y entorno. No se registran configuración, requests,
objetos, errores/stack originales ni payloads. El logger omite mensajes y
argumentos con URLs, credenciales o JWT/Bearer; las pruebas usan solo secretos
ficticios. Conservar mensajes técnicos fijos al añadir nuevos logs.

Fuentes oficiales consultadas en `Taller-SW-Web/G6-Productos-Ofertas-docs`
(master `c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b`):
[Arquitectura §§24–25](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/master/arquitectura/Arquitectura.md),
[SPEC-013](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/master/requisitos/specs/SPEC-013-gestion-precios-individuales-masivos.md),
HU/FLOW-013 y `datos/pricing/physical-model.md`.
Se revisaron registro DEC-F, trazabilidad y matriz intermodular: DEC-F-006
delimita la autoridad de Pricing; DEC-F-001 aporta la identidad SKU y DEC-F-012
la gobernanza contractual. Sus reglas de negocio quedan fuera de este bloque.
OpenAPI `0.6.0-rc.1` y AsyncAPI `0.6.0-rc.2` son candidatos consultados en master;
no se modifican contratos ni se infiere homologación externa.

## Validación y límites de evidencia

Pruebas enfocadas: `npm test -- apps/pricing-svc` y
`npm run test:e2e -- apps/pricing-svc`. Cubren configuración, errores sanitizados,
sondas independientes, recuperación simulada y PostgreSQL local inaccesible.
Los dobles de prueba se inyectan solo en tests, nunca en ejecución normal.
Implementación local no equivale a integración PostgreSQL/Supabase autenticada,
homologación, despliegue ni cierre del issue: requieren evidencia separada.

Evidencia local del 2026-10-16, Node 24.19.0: `npm test` pasó 159 pruebas;
`npm run test:e2e` pasó 337 y omitió 13 por condiciones de entorno.
`npm run typecheck`, `npm run lint`, `npm run format:check`,
`npm run build:pricing-svc` y `git diff --check`: PASS.
Smoke del ejecutable con fixtures locales: liveness 200, readiness 503 ante
PostgreSQL inaccesible, logs JSON sin la credencial ficticia; configuración
inválida termina con código 1 sin mostrar el valor rechazado. El caso ready
200 está probado con doble inyectado, no con PostgreSQL autenticado real.
