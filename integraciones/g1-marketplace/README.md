# G1 Marketplace H4 — entrada obligatoria para Backend

**Hito objetivo:** 2026-10-31. **Estado de acuerdos:** G6 aceptó y comunicó M-01–M-09 (`ACEPTADO_G6_COMUNICADO_G1`). Esta aceptación habilita el trabajo G6 dentro de sus owners; no autoriza cambios incompatibles a interfaces compartidas, ni decide por G2/G5/G7. Este paquete es la guía operativa del devteam; la fuente normativa y el OpenAPI viven en Docs.

## Orden de lectura

1. [Acuerdo normativo Docs: G1–G6 H4](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/docs/g1-marketplace-homologacion-lote03/integraciones/ACUERDO_G1_G6_H4_2026-10-20.md).
2. [OpenAPI G6](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/master/contratos/http/openapi.yaml), operación/schema aplicable.
3. [Alineación Marketplace H4 (Docs PR #94)](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/docs/g1-marketplace-homologacion-lote03/integraciones/ALINEACION_MARKETPLACE.md).
4. [Matriz de operaciones de este paquete](MATRIZ_OPERACIONES_H4.md) y [pruebas/evidencias](PRUEBAS_Y_EVIDENCIAS_H4.md).
5. SPEC/HU/Flow, DEC-F/ADR y persistencia del servicio owner según [AGENTS.md](../../AGENTS.md).

Jerarquía: DEC-F/ADR para invariantes y ownership; OpenAPI para HTTP; acuerdo para compromisos intermodulares; SPEC; matrices/kit/pruebas; documentación operativa. No dupliques ni inventes contratos.

## Acuerdos aceptados

M-01 disponibilidad de cuatro estados y D-INV-01; M-02 identidades producto/slug/variante/SKU; M-03 verificación no vinculante `binding=false`; M-04 responsabilidades separadas del snapshot; M-05 evaluación sin consumo; M-06 autoridad G5 sobre pedido/pago; M-07 idempotencia G1/G5 para pedidos y G6 para sus operaciones; M-08 autenticación BFF servicio-a-servicio y grants por G7; M-09 alcance amplio de H4 con ownership distribuido. Los nueve están `ACEPTADO_G6_COMUNICADO_G1`.

## Owners y servicios G6

- `catalog-svc` — producto, variantes, SKU y elegibilidad (Poma).
- `taxonomy-svc` — categorías y marcas comerciales (López).
- `pricing-svc` — precio por SKU/canal/vigencia (Vera).
- `inventory-svc` — disponibilidad comercial y verificación de cantidad (Taco).
- `promotions-svc` — evaluación de beneficios y cupones (Cueva).
- `api-gateway` — autenticación/autorización local, routing y propagación (Castilla).

G1 es dueño de BFF, presentación, carrito, favoritos, checkout y reintentos de pedido. G2 es dueño del contexto de envío. G5 es dueño de pedido, pago, snapshot durable y consumo/restauración coordinados. G7 registra/concede identidades y scopes. Integración no implica acceso directo a datos.

## Regla de implementación y brechas

Aplicar `IMPLEMENTAR_AHORA` a reglas internas respaldadas por DEC-F/contratos; `IMPLEMENTAR_PARCIAL` cuando una frontera externa concreta siga pendiente; `BLOQUEADO_ESPECÍFICO` solo a la operación dependiente. No bloquear un servicio completo por una brecha externa.

No inferir SKU; no sumar stock entre ubicaciones; no convertir `INDETERMINADO` en agotado/error; no transformar una verificación en reserva; no consumir cupón durante evaluación; no crear pedidos/carrito dentro de G6; no fabricar DTO de snapshot, campos G5, `fulfillment_ref`, scopes o filtros sin contrato. No tomar fixtures/mocks ni documentación YAML como prueba de runtime, grant, despliegue o E2E.

## Seguridad

Cliente técnico esperado: `modulo-marketplace`; audiencia contractual: `api-productos`; scopes según operación en OpenAPI. El BFF G1 conserva la credencial y llama en servidor. Solo G7 puede evidenciar grant/token real. `DEMO_NO_AUTH` es un bypass histórico, no cumplimiento H4. Probar scopes, audience, cliente, firma, expiración y respuestas negativas con evidencia de entorno, sin guardar secretos.

## Estados que deben registrarse por separado

`CONTRATO_DEFINIDO`, `IMPLEMENTADO`, `CI_VERIFICADA`, `DESPLEGADO`, `AUTORIZACION_VERIFICADA`, `E2E_VERIFICADO`. Cada `PASS` debe señalar el SHA exacto, operación, entorno y artefacto. CI no demuestra deploy; health 200 no demuestra readiness estable ni E2E; scope YAML no demuestra grant; prueba mock no demuestra proveedor real.

## GitHub Project H4

El inventario G1 SPECS `main@d87ebb4` v0.7.0 (19/10) define 23 funciones con datos actuales de G6 y dos dependencias indirectas/condicionales, total 25 F. Registrar el trabajo en el GitHub Project H4 ya existente y actualizar issues/PR del owner actual; no abrir duplicados ni cerrar issues por esta actualización documental. La aceptación G6 ya comunicada no es un nuevo gate para iniciar trabajo interno.

## PRs auditados

Al corte 2026-10-20: Backend #125 Poma `a81f2d5`; #10 Taco `b026158` (draft); #123 Cueva `3f42e0e` (draft); #131 López `4e099f5`; Frontend #40 Poma `4a01582`, #41 López `3d53c46`, #47 Vera `f99fb6e`; todos consultados con head y base actuales. Estos datos son huella de auditoría documental, no prueba automática de implementación/CI/deploy. Revisar la [matriz](MATRIZ_OPERACIONES_H4.md) antes de afirmar cualquier estado.

**Fuentes de verdad:** este paquete guía ejecución; Docs gobierna acuerdo, contrato y specs; el código/CI/deploy con evidencia de SHA acreditan estados técnicos.


## Matriz funcional y validador documental

`MATRIZ_OPERACIONES_H4.md` mantiene una fila por cada una de las 25 funciones G1. Ejecuta `python scripts/validate_marketplace_h4_docs.py` desde la raíz de Backend para comprobar el número y unicidad de funciones, los operationIds contra el OpenAPI canónico de Docs cuando esté disponible en `../docs-g1-h4`, los nueve acuerdos aceptados, los puntos de ownership críticos y enlaces Markdown relativos. Si Docs no está accesible, el validador reporta `NO_EJECUTADO: FUENTE_NO_DISPONIBLE`.
