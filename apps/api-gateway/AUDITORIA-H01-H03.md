# Evidencia de correcciones H-01, H-02 y H-03 — PR #116

Rama de publicación: `cueva`. Alcance: únicamente `apps/api-gateway`, con la
autorización transversal de #106/#21 y las aclaraciones de arquitectura.
OpenAPI 0.6.0-rc.1, Docs `c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b`.
El SHA publicado y la ejecución de CI se registran en la descripción del PR.

## Correcciones verificables

| Hallazgo | Resultado                                                                                                                                                                                   | Pruebas positivas y negativas                                                                                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H-01     | Los errores locales usan un conjunto cerrado de códigos de validación, identidad, autorización e indisponibilidad. Los errores de proveedores conservan la validación por operación.        | 400/403 legítimos en operaciones que no los enumeran; códigos locales desconocidos y códigos no declarados del proveedor se rechazan y sanitizan.                                            |
| H-02     | Imports multipart y respuestas de archivos se transmiten con backpressure. El presupuesto de memoria JSON no define el máximo contractual de un archivo.                                    | Imports y reporte de 11 MiB; conservación de 413 `ARCHIVO_EXCEDE_LIMITE`, también temprano; rechazo sin autenticación, JSON por encima de su presupuesto y tipos de respuesta no declarados. |
| H-03     | Healthcheck ejecutable compilado, sin listener adicional, comprueba liveness del Gateway y readiness de las dependencias habilitadas. Las rutas requieren verificación explícita del owner. | Dependencias listas, caídas, ausentes, lentas, respuestas inválidas, liveness sin readiness, cero dependencias, configuración parcial e inválida; salida 0/1 del ejecutable.                 |

Se conserva el routing de las **135 operaciones y 108 paths**, sin allowlist de
rutas para INT-ASAP. Las **133 operaciones protegidas** rechazan identidad
ausente o roles insuficientes antes de contactar al proveedor. Permanecen las
audiencias, scopes, clientes permitidos, headers contractuales, timeouts,
sanitización y rechazo seguro de las cinco operaciones que requieren
introspección todavía no integrada. Las dos rutas SEO conservan su política
previa de exposición explícita; no se implementa #107.

## Fuentes y límites

OpenAPI y SPEC-001/SPEC-013 consultadas no definen un máximo numérico de bytes
para los tres imports. El owner del servicio aplica su límite y el Gateway
propaga el rechazo contractual; no se convierte el máximo de 10 MiB del
prototipo en una regla de negocio. JSON y Problem Details bufferizados conservan
su presupuesto técnico de memoria y todas las operaciones su timeout.

Los controladores de los ocho proveedores revisados en Backend
`24227527c632be4f3b8de612954328904ea57de0` solo acreditan `/health`.
No se presume que implementen `/health/ready`. Sin ruta explícita verificada,
una dependencia habilitada queda `unverified` y el healthcheck falla.
Una cobertura parcial lista solo acredita los servicios habilitados. No
acredita disponibilidad de las 135 operaciones ni integración de negocio.

## Comandos ejecutados

Validación realizada sobre el árbol exacto del PR con estas correcciones,
aislado de los commits locales de otros issues:

| Comando                                                                    | Resultado                                                     |
| -------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `npm test -- apps/api-gateway --maxWorkers=1`                              | PASS: 57 unitarias del Gateway                                |
| `npm run test:e2e -- apps/api-gateway --maxWorkers=1`                      | PASS: 289 HTTP del Gateway                                    |
| `npm test -- --maxWorkers=1`                                               | PASS: 65 unitarias generales                                  |
| `npm run test:e2e -- --maxWorkers=1`                                       | PASS: 297 HTTP generales                                      |
| `node --test scripts/seed/run.test.mjs`                                    | PASS: 14 pruebas, sin credenciales de base de datos           |
| `npm run typecheck`                                                        | PASS                                                          |
| `npm run lint`                                                             | PASS                                                          |
| `npm run format:check`                                                     | PASS                                                          |
| `npm run build`                                                            | PASS                                                          |
| `npm run build:all`                                                        | PASS: nueve aplicaciones                                      |
| `node apps/api-gateway/test/readiness.smoke.mjs`                           | PASS: proceso compilado con proveedores HTTP aislados         |
| `prettier --check` sobre README y smoke del healthcheck                    | PASS                                                          |
| Regenerar inventario desde el OpenAPI fijado, formatear y comparar con Git | PASS: 135 operaciones/108 paths, archivo generado sin cambios |
| `git diff --check`                                                         | PASS                                                          |

Vitest necesitó ejecución fuera de la restricción de caché temporal del sandbox
de Windows (`EPERM` al renombrar archivos); las suites completas pasaron allí.
La comprobación compilada usa un timeout de prueba de 1 s y una dependencia de
2 s para verificar el rechazo por deadline sin confundirlo con el arranque del
proceso de prueba. No se modificaron configuración global ni dependencias.

## Dependencias específicas y entrega

| Owner                                   | Operación afectada                 | Condición de desbloqueo                                                                                    |
| --------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Cada owner de upstream                  | Readiness de su servicio           | Acreditar ruta y respuesta técnica de readiness, distintas de liveness, antes de configurar la sonda.      |
| Infraestructura G6                      | Adopción del healthcheck           | Incorporar `node dist/apps/api-gateway/readiness.js` al mecanismo de despliegue con las rutas verificadas. |
| Owners de upstreams e integración G6/G7 | Integración autenticada de negocio | Handlers reales, issuer/JWKS, grants y credenciales efectivos por operación; ejecutar las pruebas reales.  |
| Pricing/G7                              | Cinco mutaciones con introspección | Adaptador autorizado y pruebas contra el contrato vigente.                                                 |

Implementación y pruebas locales: **PASS**. Integración autenticada,
homologación externa y despliegue: **NO EJECUTADOS**. Los proveedores aislados
no se presentan como integración real. `/health` y el puerto 3000 se conservan.
Sin cambios en contratos, otros microservicios, Oracle, Caddy, Compose, RabbitMQ,
scripts de CD o archivos compartidos. #107/#108 y despliegue quedan fuera del
alcance. Sin merge del PR.
