# Consolidación Gateway — #106 / #21 / PR #116

Owner: Axel Cueva. Rama permanente: `cueva`. Fecha: 16/10/2026, America/Lima.

## Fuentes y base

- Cueva: `68c96a77ab8c77b1f218d6283de7e1f4efa45e4f`.
- Castilla: `fbbb74a528c73989c83f53e27690bcfcba966308`.
- Master actualizado: `24227527c632be4f3b8de612954328904ea57de0`.
- OpenAPI 0.6.0-rc.1, blob `f64bfe9a097b2a0f74c2600988305443d92f640e`;
  Arquitectura/DEC-F-012 y fuentes de H-01/H-02/H-03 del informe existente.

La base master se incorpora mediante merge explícito conservando historial,
sin rebase, reset, force push ni modificación de `castilla`. Los archivos de
Foundation/CI/CD heredados de master coinciden con esa base y no son cambios
nuevos del Gateway frente a master. No se incorporan los commits de servicios o
infraestructura adicionales de `castilla`. El trabajo DATA local queda fuera
de esta publicación.

## Comparación archivo por archivo y decisiones

`test/verify-consolidation.mjs` contrasta los **44 paths** presentes en al menos
una de las dos versiones y registra blobs de ambas fuentes, blob local y decisión
en `test/evidence/consolidation-2026-10-16.json`. Las fuentes son commits
inmutables; una comparación de archivos no se presenta como ejecución de tests.

| Grupo                                                                                                                      | Diferencia encontrada                                                                                                                                     | Decisión                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gateway-proxy.ts`                                                                                                         | Castilla conserva la selección antigua de tres imports multipart y no el drenado de uploads rechazados.                                                   | Conservar íntegramente Cueva: todos los multipart contractuales, logos, errores 413 y drenado antes de finalizar respuesta.                                                                                     |
| `streamed-request.ts`                                                                                                      | Solo cambia el comentario relativo a límites de logos.                                                                                                    | Conservar la precisión de SPEC-011 en Cueva; implementación de streaming idéntica.                                                                                                                              |
| `routing.e2e-spec.ts`                                                                                                      | Castilla carece de las diez regresiones adicionales de marcas de 68c96a7.                                                                                 | Conservar todas las pruebas de Cueva, que contienen las anteriores de Castilla.                                                                                                                                 |
| Configuración, identidad/JWT, autorización, readiness, controladores, módulo, main, inventario contractual y demás runtime | Sin diferencias funcionales; Castilla reutilizó 98ad846.                                                                                                  | Conservar los mismos blobs del runtime de Cueva. No crear implementación paralela.                                                                                                                              |
| `marketplace.live.mjs` y `marketplace-eligibility.cases.json`                                                              | Herramientas adicionales de Castilla para el corte Marketplace.                                                                                           | Incorporar sus bytes originales; el fixture de casos no es dataset ni política productiva aprobada.                                                                                                             |
| `marketplace.postgres.e2e-spec.ts`                                                                                         | Cuatro escenarios de procesos compilados + PostgreSQL; rutas privadas fijas de otra máquina.                                                              | Incorporar los cuatro casos, sustituyendo rutas por configuración local explícita y probada. No importar código entre servicios.                                                                                |
| Documentos/evidencias históricas de intervención y probes externos                                                         | Requieren archivos privados, Drizzle no declarado en Cueva, fuentes de otros servicios y/o comparación contra 98ad846 que rechazaría la corrección nueva. | Conservarlos en su fuente inmutable enlazada abajo. No copiar un probe SQL ajeno al rol HTTP del Gateway ni reemitir evidencias de otra máquina como nuevas. La auditoría nueva los inventaría individualmente. |

Fuente histórica completa:
[Castilla fbbb74a — Gateway](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/tree/fbbb74a528c73989c83f53e27690bcfcba966308/apps/api-gateway).
La evidencia anterior de Taxonomy real y Catalog cerrado con 503 se conserva
como historia. No acredita disponibilidad comercial actual ni una ejecución
desde Cueva. El manifiesto histórico no se ejecuta: lee rutas privadas ajenas y
exige un Gateway antiguo byte a byte.

## Regresiones nuevas y reproducción

`marketplace.e2e-spec.ts` agrega 13 regresiones de transporte y seguridad con
proveedor HTTP aislado: categorías, búsqueda, vacío, detalle simple/variantes,
SKU con ceros iniciales, 404 inexistente/no elegible, 503 específico y rechazos
de token/scope/cliente antes del upstream en los tres GET. El proxy conserva
DTO/query/correlación y sanitiza errores. La elegibilidad está representada por
la respuesta explícita del proveedor de prueba; no se implementa una política
de Catálogo dentro del Gateway ni se acredita SQL/BFF mediante fixtures.

Para los cuatro escenarios PostgreSQL heredados, configurar **antes** de activar:

```text
G6_HTTP_POSTGRES_INTEGRATION=1
MKT_TAXONOMY_ENV_FILE=<ruta absoluta al env runtime autorizado de Taxonomy>
MKT_TAXONOMY_ENTRYPOINT=<ruta absoluta al main.js compilado del owner>
MKT_CATALOG_ENV_FILE=<ruta absoluta al env runtime autorizado de Catalog>
MKT_CATALOG_ENTRYPOINT=<ruta absoluta al main.js compilado del owner>
```

Los archivos deben existir y contener la configuración de sus owners. El
harness inicia y detiene solo los procesos que crea, en loopback, conserva
RS256/issuer/exp/audiencia/scopes/allowlists y oculta salidas privadas. Requiere
los proveedores funcionales de los owners; los scaffolds de master no los
sustituyen. No copia credenciales, crea grants ni escribe a PostgreSQL.

```powershell
npm test -- apps/api-gateway --maxWorkers=1
npm run test:e2e -- apps/api-gateway --maxWorkers=1
node apps/api-gateway/test/verify-consolidation.mjs
node apps/api-gateway/test/marketplace.live.mjs
```

El smoke externo conserva las variables `MKT_*` del script original, tokens
firmados válidos/negativos y fixture elegible publicado. Si faltan condiciones,
reporta `NO_EJECUTADO`; no es un fallo funcional corregible quitando seguridad.

## Dependencias compartidas

`package.json` y `package-lock.json` compartidos conservan exactamente los blobs
de Cueva. El Gateway no necesita pg/Drizzle para hacer proxy HTTP. La propuesta
para coordinar es **pg 8.23.1 + drizzle-orm 0.45.4 + @types/pg 8.23.1**, conservando
**amqplib 0.10.9** de #33. No copiar el manifiesto de Castilla: omitiría amqplib y
rompería el arranque/imports de Promotions.

Las APIs utilizadas son Pool/connect/query/release/end y transacciones con un
solo cliente; la documentación oficial de [node-postgres](https://node-postgres.com/apis/pool)
y el [adaptador Drizzle/node-postgres](https://orm.drizzle.team/docs/get-started-postgresql)
se consultaron para la propuesta. La matriz experimental se ejecuta solamente
en una copia temporal con manifiesto/lock propios; no autoriza actualizar los
compartidos. Marco debe autorizar la consolidación de esos archivos y los owners
de Catálogo/Taxonomía/Promotions verificar sus flujos con el lock elegido antes
de adoptarlo como definitivo. Los resultados concretos se registran en la
evidencia de validación.

## Fronteras pendientes

| Owner                 | Operación afectada                                 | Desbloqueo                                                                                                         |
| --------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| López/Poma/Marco      | Repetir los cuatro escenarios PostgreSQL heredados | Artefactos compilados funcionales y configuración runtime autorizada accesibles en esta máquina.                   |
| Poma/Marco            | HTTP comercial Catalog y smoke positivo            | Política D-CAT-05/06 implementada y fixtures elegibles publicados; no sustituir 503 por éxito vacío.               |
| G1/G7/coordinación G6 | Piloto BFF autenticado y homologación              | Credenciales/grants efectivos, BFF/entorno acordados y requests reproducibles; no se infieren de tokens de prueba. |
| Marco/owners          | Dependencias compartidas                           | Autorización expresa del manifiesto/lock y regresiones de cada owner.                                              |
| Inventory/G5/Marco    | Evidencia funcional del cupón #33                  | Fuente autorizada para verificar reserva realmente confirmada y snapshot durable; 202 no es confirmación.          |

#33 conserva el núcleo transaccional y el consumidor ya existentes, sin activarlos
contra RabbitMQ compartido. Su integración operativa/probes/dispatcher quedan
separados de esta consolidación. #71/#72/#75 conservan los gates BACK y se
reutilizará ese núcleo; DATA #15/#112 conserva sus referencias/autorizaciones
pendientes. No se atribuye implementación, homologación o despliegue por publicar
este Gateway. No fusionar #116 ni cerrar issues automáticamente.

Para desbloquear el adaptador de #33, Inventory/G5 deben publicar el mecanismo
autorizado para resolver `reservation_id` junto con el pedido y comprobar su
confirmación definitiva. El GET de operaciones por `operationId`, autorizado a
Ventas, no se convierte en consulta por reserva ni se concede a Promotions por
inferencia. G5 debe definir la fuente verificable/versionada de
`commercial_snapshot_ref` y su vínculo con pedido/reserva/cupón/canal/cliente,
incluyendo la información comercial necesaria para revalidar las reglas propias.
No se inventa un endpoint, DTO, grant ni suscripción nueva para suplirlos.

## Validaciones ejecutadas sobre la consolidación

Instalación temporal con el lock exacto de Cueva: `npm ci --no-audit --no-fund`
PASS, 362 paquetes. Se conserva el node_modules original. La primera ubicación
dentro de node_modules se descartó porque las herramientas omitían lint y parte
de la transformación; los checks siguientes se repitieron fuera de ese directorio,
en TEMP. No se cambiaron los configs globales para hacerlos pasar.

| Comando                                                                     | Resultado real                                                                                    |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `npm test -- apps/api-gateway --maxWorkers=1`                               | PASS: 59 unitarias enfocadas.                                                                     |
| `npm run test:e2e -- apps/api-gateway --maxWorkers=1`                       | PASS: 312 HTTP; 4 casos PostgreSQL optativos NO EJECUTADOS.                                       |
| `npm test -- --maxWorkers=1` en copia limpia                                | PASS: 124 unitarias generales.                                                                    |
| `npm run test:e2e -- --maxWorkers=1` en copia limpia                        | PASS: 324 HTTP generales; 4 optativas NO EJECUTADAS.                                              |
| `npm run typecheck`, `npm run lint`, `npm run format:check` en copia limpia | PASS.                                                                                             |
| `npm run build` y `npm run build:all` en copia limpia                       | PASS; nueve aplicaciones compiladas.                                                              |
| `node apps/api-gateway/test/readiness.smoke.mjs` en copia limpia            | PASS; executable/CLI y proveedores aislados.                                                      |
| `node apps/promotions-svc/test/startup.smoke.mjs` en copia limpia           | PASS; arranque/configuración/liveness, sin integración DB/broker.                                 |
| Tres suites DATA previamente publicadas, con `node --test`                  | PASS: 21 pruebas; no incluye el nuevo trabajo DATA local.                                         |
| `node apps/api-gateway/test/verify-consolidation.mjs`                       | PASS: 44 paths comparados; 135 operaciones preservadas.                                           |
| `node apps/api-gateway/test/marketplace.live.mjs`                           | NO EJECUTADO: faltan origen, fixture elegible, tokens firmados y SHA de Gateway/Taxonomy/Catalog. |

Matriz de dependencias **solo temporal**: pg 8.23.1, Drizzle 0.45.4,
@types/pg 8.23.1, amqplib 0.10.9. Instalación limpia PASS (364 paquetes),
124 unitarias y 324 HTTP PASS (mismas 4 optativas no ejecutadas), typecheck y
build de las nueve apps PASS. Construcción del adaptador Drizzle con pg.Pool
PASS sin conectar; no equivale a consultas de los repositorios de otros owners.
También pasó el smoke de cupones con PostgreSQL 17.11/RabbitMQ descartables:
10 escenarios, incluyendo redelivery, pérdida de ACK, publicación fallida y
recuperación con publisher confirms. No es integración G5/Inventory ni uso del
broker compartido. La propuesta sigue pendiente de autorización del lock común.

La evidencia reproducible y hashes de los archivos probados están en
`test/evidence/consolidation-validation-2026-10-16.json`. Los SHA publicados y
CI del commit final se registran en #116; resultados locales no sustituyen CI.
Estado: implementación/consolidación local probada; cuatro escenarios de
proveedores reales y smoke externo pendientes; homologación y despliegue no
ejecutados. **PARTIAL para integración, no cierre automático de issues.**
