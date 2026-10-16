# Evidencia de correcciones H-01, H-02 y H-03 — PR #116

La consolidación posterior con `castilla` conserva íntegramente estas
correcciones y sus regresiones. Las decisiones por archivo y las nuevas
validaciones se documentan en [CONSOLIDACION-GATEWAY.md](CONSOLIDACION-GATEWAY.md).
Los resultados fechados que siguen se conservan como evidencia histórica.

Este informe corresponde al bloque Gateway validado en
`b97138acdc7fa87bd854a8ed7bea1a96c87da902`. Posteriormente, el usuario autorizó
incorporar también los siete commits locales de #70/#112/#15/#33 al mismo PR.
Es una excepción puntual autorizada para #116; la regla de PRs pequeños,
atómicos y específicos de AGENTS.md sigue vigente para las próximas entregas.
La descripción del PR distingue las validaciones históricas de este bloque de
las del conjunto ampliado, sus dependencias autorizadas y el nuevo SHA final.

Rama de publicación: `cueva`. Alcance: únicamente `apps/api-gateway`, con la
autorización transversal de #106/#21 y las aclaraciones de arquitectura.
OpenAPI 0.6.0-rc.1, Docs `c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b`.
El SHA publicado y la ejecución de CI se registran en la descripción del PR.

## Seguimiento de auditoría: H-02 de marcas y H-04 diferido

H-01 y H-03 fueron aceptados como corregidos; su implementación se conserva.
La corrección adicional de H-02 transmite **todos los multipart contractuales**:
tres imports y `crearMarca`/`actualizarMarca`, sin depender de un código de error
exclusivo de importación. El inventario de 135 operaciones/108 paths no cambia.

Fuente: OpenAPI y SPEC-011 del mismo commit Docs indicado arriba. SPEC-011 fija
un máximo de **5 MB para el logo**, aplicado por el owner Taxonomía. El Gateway
no convierte su presupuesto JSON de 10 MiB en un límite del logo ni introduce
otro máximo; transmite el archivo y conserva `413 LOGO_EXCEDE_LIMITE`.
Ante rechazo temprano lee primero el problema del proveedor y descarta sin
bufferizar el resto del cuerpo entrante antes de finalizar la respuesta, dentro
del timeout existente. Se evita el cierre que ocultaba el 413 durante la subida.

Diez regresiones HTTP nuevas, cinco por operación:

- Éxito controlado 201/200 con fixture de logo de 2 MiB, por encima del presupuesto
  JSON de prueba de 1 MiB y por debajo del límite de SPEC-011; conserva bytes,
  framing, método, path y correlación.
- Logo de 11 MiB: conserva 413 `LOGO_EXCEDE_LIMITE` normal y temprano, sanitizado.
- Un 413 con código de importación ajeno se rechaza, sin ampliar el contrato.
- Sin identidad o sin permisos: 401/403 antes de contactar al proveedor.

Las nuevas pruebas reprodujeron el fallo antes de corregirlo. Son fixtures de
transporte y proveedores aislados: no acreditan validación real de imágenes ni
integración con Taxonomía. No se relajan ni omiten las pruebas anteriores.

Verificación del árbol ampliado con esta corrección:

| Comando                                                           | Resultado                     |
| ----------------------------------------------------------------- | ----------------------------- |
| HTTP filtradas por `brand multipart`                              | PASS: 10 nuevas regresiones   |
| `npm test -- apps/api-gateway --maxWorkers=1`                     | PASS: 57 unitarias            |
| `npm run test:e2e -- apps/api-gateway --maxWorkers=1`             | PASS: 299 HTTP                |
| `npm test -- --maxWorkers=1`                                      | PASS: 122 unitarias generales |
| `npm run test:e2e -- --maxWorkers=1`                              | PASS: 311 HTTP generales      |
| Tests Node del runner, borrador y restore-plan                    | PASS: 21 pruebas              |
| `npm run typecheck`, `npm run lint`, `npm run format:check`       | PASS                          |
| `npm run build`, `npm run build:all`                              | PASS                          |
| Smoke compilado de readiness Gateway y startup Promotions         | PASS                          |
| Regeneración del inventario y comparación de código JWT/H-01/H-03 | PASS: sin cambios             |
| Formato de documentos y `git diff --check`                        | PASS                          |

H-04 queda **diferido y no bloqueante**, registrado en
[backend #107](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/107#issuecomment-6223045108).
Axel/integración G6, G7/Seguridad y Marco deben acordar la tolerancia de reloj
antes de implementar y probar la validación adicional de `iat` futuro.
No se habilita integración G7 ahora ni se modifica JWT, guards, autorización
o comportamiento fail-closed de las operaciones protegidas.

La autorización expresa de `pg@8.16.3` y `amqplib@0.10.9` quedó registrada en
[backend #33](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/33#issuecomment-6223044436),
con el alcance exacto de package.json/package-lock.json y la trazabilidad de
los siete commits incluidos por excepción puntual en #116. Esa excepción no
cambia la política de PRs pequeños y específicos para las próximas entregas.
Esta corrección no modifica dependencias, contratos, otros servicios o
infraestructura; sin despliegue ni merge del PR.

## Evidencia histórica del bloque inicial

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
