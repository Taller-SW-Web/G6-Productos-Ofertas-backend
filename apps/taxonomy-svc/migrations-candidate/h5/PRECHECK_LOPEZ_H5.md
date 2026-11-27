# Preflight López H5 — actualización 2026-11-27

El bloqueo histórico siguiente quedó superado: #301 fue fusionado el 2026-11-27T03:43:07Z mediante `a3f863481e5523fdd2201264bab2e060a4f78787`. Su HEAD `93210d593af11209a13832bdc456dc9d6a24c127` y `08399d51b665155a919fa53b4ac3fa3a5d805568` son ancestros de `origin/master` `097dac1bf4a8dcf5c6e799742d2df340f6d893d5`. La reconciliación está en curso y el merge local no está finalizado; esta nota no acredita LOP-01 a LOP-05.

## Registro histórico del 2026-11-26

**Estado: BLOCKED_INTEGRAL_MERGE.** PR integral [#301](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/pull/301) abierto, Ready, sin merge. `git merge-base --is-ancestor origin/trabajo/castilla/h5-integral-r2 origin/master` devolvió **1**. No se ha ejecutado merge, DDL, modificación del runtime ni push durante este preflight.

| Referencia | SHA / estado |
|---|---|
| Backend origin/master | `5ee5053e0206e0738a13c9104c2ef9d5e24cda1f` |
| Integral candidato | `08399d51b665155a919fa53b4ac3fa3a5d805568`, #301 OPEN |
| Frontend master | `deb239867ffde06fbff4ec3d803b4783a356b635` |
| Docs master | `099ad1926a53d1aec1aeae93e894d24ec2721748` |
| Backend #300 | `f43cea6812e2c1104a2aa2ba5eb3932b65309a71`, OPEN DRAFT |
| Backend #264 | `96c1a799626df1f63e53d73e14bda8c1c430e8d7`, OPEN READY |
| Backend #247 | `fb0225b5b5aabccc818bf4d6a5330757008cdb9c`, OPEN READY |
| Backend #224 | `ef792a37f6feeb0c100f8ff654f7f191104a369b`, OPEN READY |
| Frontend #96 | `34bfc119d9874105eb3f337652f562e5e1db7f70`, MERGED |
| Frontend #91 | `54dea7a4de0168361f0b537f2f1c62a16bcb9cf8`, MERGED |
| Frontend #79 | `d3641ae4d1a4226d223b142157479aa13996490c`, OPEN READY |

Los archivos `contratos/eventos/asyncapi.yaml` y `contratos/http/openapi.yaml` del Docs indicado declaran `0.7.0-rc.3`. No acredita homologación o despliegue.

## Clasificación preliminar de archivos cambiados

`YA_INTEGRADO` en esta tabla significa presente en el **integral candidato**, no en master. Se debe recalcular después de su merge. Los archivos de otros bounded contexts no se clasifican ni modifican en este trabajo.

| Archivo | Clase | Referencia |
|---|---|---|
| `apps/taxonomy-svc/migrations-candidate/h5/INVENTARIO_R09_R18.md` | SOLO_PR300 | solo PR #300 |
| `apps/taxonomy-svc/migrations-candidate/h5/README.md` | RECONCILIAR | PR #300 e integral candidato |
| `apps/taxonomy-svc/migrations-candidate/h5/preflight-readonly.sql` | YA_INTEGRADO | PR #300 e integral candidato |
| `apps/taxonomy-svc/migrations/0006_service_bus_outbox_delivery.sql` | SOLO_PR300 | solo PR #300 |
| `apps/taxonomy-svc/src/category-seo-auth.spec.ts` | YA_INTEGRADO | solo integral candidato |
| `apps/taxonomy-svc/src/category-seo.controller.ts` | YA_INTEGRADO | solo integral candidato |
| `apps/taxonomy-svc/src/config/service-bus.ts` | YA_INTEGRADO | PR #300 e integral candidato |
| `apps/taxonomy-svc/src/database.ts` | YA_INTEGRADO | solo integral candidato |
| `apps/taxonomy-svc/src/domain/deactivation-check.spec.ts` | YA_INTEGRADO | PR #300 e integral candidato |
| `apps/taxonomy-svc/src/domain/taxonomy-amqp.runtime.ts` | YA_INTEGRADO | PR #300 e integral candidato |
| `apps/taxonomy-svc/src/domain/taxonomy-service-bus.runtime.spec.ts` | RECONCILIAR | PR #300 e integral candidato |
| `apps/taxonomy-svc/src/domain/taxonomy-service-bus.runtime.ts` | RECONCILIAR | PR #300 e integral candidato |
| `apps/taxonomy-svc/src/health/readiness.controller.spec.ts` | YA_INTEGRADO | PR #300 e integral candidato |
| `apps/taxonomy-svc/src/health/readiness.controller.ts` | YA_INTEGRADO | PR #300 e integral candidato |
| `apps/taxonomy-svc/src/persistence/taxonomy-message.store.ts` | YA_INTEGRADO | PR #300 e integral candidato |
| `apps/taxonomy-svc/src/phase1-public-reads.spec.ts` | YA_INTEGRADO | solo integral candidato |
| `apps/taxonomy-svc/src/phase1-public-reads.ts` | YA_INTEGRADO | solo integral candidato |
| `apps/taxonomy-svc/src/taxonomy-auth.ts` | YA_INTEGRADO | solo integral candidato |
| `apps/taxonomy-svc/src/taxonomy-public-reads.spec.ts` | YA_INTEGRADO | solo integral candidato |
| `apps/taxonomy-svc/src/taxonomy.controller.spec.ts` | YA_INTEGRADO | solo integral candidato |
| `apps/taxonomy-svc/test/persistencia-drizzle.e2e-spec.ts` | YA_INTEGRADO | solo integral candidato |
| `tests/h5/contract-r18.mjs` | YA_INTEGRADO | PR #300 e integral candidato |
| `tests/h5/run-taxonomy-catalog-postgres.mjs` | YA_INTEGRADO | PR #300 e integral candidato |
| `tests/h5/taxonomy-service-bus.postgres.e2e-spec.ts` | RECONCILIAR | PR #300 e integral candidato |

| `apps/taxonomy-svc/INVENTARIO_ADMIN_FRONTEND.md` (#224) | RECONCILIAR | insumo histórico, pendiente conciliación 26/42 |
| `apps/taxonomy-svc/test/qa-gateway-admin.mjs` (#224) | RECONCILIAR | insumo histórico; no ejecutar contra QA sin autorizaciones |
| `apps/taxonomy-svc/test/qa-gateway-admin.test.mjs` (#224) | RECONCILIAR | tests históricos, pendiente evaluación |
| `apps/taxonomy-svc/src/messaging/*` (#247) | DESCARTAR_HISTORICO | runtime alternativo; no portar |
| `apps/taxonomy-svc/migrations/0006_service_bus_outbox_delivery.sql` (#247) | DESCARTAR_HISTORICO | variante incompatible; no confundir con #300 |

## Desbloqueo

Castilla debe completar el merge integral #301 a master conforme a las protecciones y proporcionar evidencia del SHA resultante. Luego repetir fetch, verificar que el HEAD aprobado está en master, reconciliar #300 y ejecutar LOP-01, LOP-02, LOP-03 y LOP-05. El estado de Supabase y grants reales no se ha inspeccionado ni modificado; no inferir SQL-UPGRADE PASS.

## Corte local provisional de 0006

SHA-256 del archivo de trabajo: `4d0edd7b8347e60bd1ead4558184f9a35b9a14618431c120085cfc3dddece03a`. SQL-CLEAN instala sobre H4; SQL-UPGRADE valida el almacenamiento H5 existente y no realiza backfill. No ejecutar en Supabase compartido. Reversión: detener el runtime, preservar los datos y restaurar desde respaldo validado bajo coordinación del owner; no descartar entregas ni aplicar un rollback destructivo automáticamente. La verificación integral y el SHA publicado siguen pendientes.
