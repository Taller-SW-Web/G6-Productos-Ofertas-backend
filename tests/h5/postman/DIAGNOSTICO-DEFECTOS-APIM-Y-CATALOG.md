# Diagnóstico Técnico de Defectos APIM/Backend y Brechas Históricas de Catalog (H5)

Este documento consolida la investigación técnica de los tres defectos observados en las corridas reales contra APIM Chile (`azure-apim-smoke-jws-2026-11-28` y `azure-apim-integration-jws-2026-11-28`) y la trazabilidad de las 6 brechas históricas de `catalog-svc` vinculadas al PR Backend #310.

> **Restricción operativa (`STANDBY`):** Todas las verificaciones actuales son locales y aisladas (`ISOLATED`). No se ha ejecutado ninguna corrida nueva contra Azure APIM, ACA, Service Bus ni G7, ni se han modificado archivos tocados por `Backend #310` o `Frontend #103`.

---

## 1. Diagnóstico de los 3 defectos reproducidos en APIM Chile (`FAIL / LAB_AZURE`)

### Defecto A — APIM 401 no cumple RFC 7807 (`PM-004` / `PM-004B`)

- **Evidencia real:** `PM-004` (sin token) y `PM-004B` (token inválido) devolvieron HTTP `401` con cuerpo `{ "statusCode": 401, "message": "Unauthorized" }` (`application/json`), en lugar de `application/problem+json` con `code: "TOKEN_INVALIDO"`, `title`, `status: 401`.
- **Causa raíz exacta:**
  - `ops/azure/apim/policies/operation-secured.xml` (línea 4): `<validate-jwt ... failed-validation-httpcode="401" failed-validation-error-message="Unauthorized">`.
  - `ops/azure/apim/policies/api.xml`: no cuenta con bloque `<on-error>` que transforme el `401` nativo de `<validate-jwt>` al contrato RFC 7807 (`Problem`).
- **Clasificación:** Defecto de configuración en capa APIM (no se deben debilitar las aserciones de Newman).
- **Propuesta de corrección para Axel (`ops/azure/apim/policies/api.xml`):**
  ```xml
  <on-error>
    <base />
    <choose>
      <when condition="@(context.Response != null && context.Response.StatusCode == 401)">
        <set-header name="Content-Type" exists-action="override">
          <value>application/problem+json</value>
        </set-header>
        <set-header name="X-Correlation-Id" exists-action="override">
          <value>@(context.Request.Headers.GetValueOrDefault("X-Correlation-Id", context.RequestId.ToString()))</value>
        </set-header>
        <set-body>@{
          var cid = context.Request.Headers.GetValueOrDefault("X-Correlation-Id", context.RequestId.ToString());
          return new JObject(
            new JProperty("type", "about:blank"),
            new JProperty("title", "No autorizado"),
            new JProperty("status", 401),
            new JProperty("code", "TOKEN_INVALIDO"),
            new JProperty("correlationId", cid)
          ).ToString();
        }</set-body>
      </when>
    </choose>
  </on-error>
  ```
- **Estado:** `STANDBY` (pendiente aplicación en APIM por responsable de infraestructura y revalidación futura).

---

### Defecto B — Inventory `PM-012` devolvió HTTP 400 (`GET /api/v1/inventario/disponibilidad?skus=...`)

- **Evidencia real:** `PM-012` devolvió HTTP `400` (`VALIDACION`) cuando omitió `location_id`.
- **Causa raíz exacta:**
  - `apps/inventory-svc/src/disponibilidad/disponibilidad.service.ts` (líneas 104–112):
    ```ts
    if (
      locationId === undefined &&
      new Set(balances.map((row) => row.location_id)).size > 1
    ) {
      throw ProblemDetailsException.validation(
        'Debe especificar location_id cuando hay más de una ubicación de inventario',
        correlationId,
      );
    }
    ```
- **Clasificación:** **Comportamiento contractual legítimo de `inventory-svc`**, NO defecto del microservicio. En el entorno live existen múltiples ubicaciones de inventario para el SKU encadenado.
- **Corrección implementada (`PASS / ISOLATED`):**
  - `PM-012` en `tests/h5/postman/g6-h5-integration.postman_collection.json` ahora utiliza `location_id` si está definido en `G6_LOCATION_ID` o lo descubre de forma segura mediante `safeSendRequest` contra `GET /api/v1/inventario/ubicaciones`, anexando `&location_id={{locationId}}`.
  - Se agregó regresión automatizada en `tests/h5/postman/tests/runner.test.mjs` que simula el `400 VALIDACION` multi-ubicaciones y verifica `200 OK` al descubrir `location_id`.
- **Estado:** `PASS / ISOLATED` (revalidación real en APIM en `STANDBY`).

---

### Defecto C — Bulk `PM-030` / `PM-031` devolvieron HTTP 401 con JWS válido de `GESTOR_COMERCIAL`

- **Evidencia real:** El mismo JWS válido (`GESTOR_COMERCIAL`, 3 partes) fue aceptado (`200 OK`) por `catalog-svc`, `pricing-svc`, `inventory-svc`, `combos-svc`, `taxonomy-svc`, `promotions-svc` y `price-audit-svc`, pero rechazado con HTTP `401` (`TOKEN_INVALIDO`) por `bulk-svc` en `PM-030` y `PM-031`.
- **Causa raíz exacta (Defecto real en Backend `bulk-svc`):**
  - `apps/bulk-svc/src/auth/bulk-user-bearer.guard.ts` (líneas 93 y 117–124):
    ```ts
    !hasProductsAudience(claims.aud)
    ```
    donde `hasProductsAudience` exige `aud === 'api-productos'` incluso para tokens humanos (`claims.tipo === 'acceso'`).
  - Sin embargo, los tokens humanos JWS emitidos por G7 para `GESTOR_COMERCIAL` **no incluyen `aud: 'api-productos'`** (ese `aud` aplica únicamente a tokens M2M `tipo: 'servicio'`, como confirma `ops/azure/apim/policies/operation-secured.xml` líneas 34–50 y el comportamiento uniforme de los otros 7 microservicios).
- **Impacto en Frontend (sin defecto de Frontend):**
  - El cierre de sesión observado en Frontend al descargar la plantilla del catálogo es consecuencia directa del `401 TOKEN_INVALIDO` devuelto por `bulk-svc` (el interceptor de Frontend maneja correctamente `401` expirando la sesión).
  - Por tanto, **no corresponde modificar Frontend ni abrir un PR vacío en `G6-Productos-Ofertas-frontend`**.
- **Propuesta de corrección para `bulk-svc`:**
  - Alinear `BulkUserBearerGuard` con la política de APIM y los demás servicios: para tokens humanos (`tipo === 'acceso'`), validar `iss`, `sub`, `iat`, `exp`, `jti`, `roles.includes('GESTOR_COMERCIAL')` sin exigir `aud === 'api-productos'` (o exigir `aud` únicamente cuando el claim está presente / en flujos M2M), añadiendo prueba unitaria en `bulk-svc` para JWS humano sin `aud: 'api-productos'`.
- **Estado:** Diagnosticado con ubicación exacta; corrección en `bulk-svc` coordinada sin interferir con PR #310 y revalidación en APIM en `STANDBY`.

---

## 2. Brechas históricas de `catalog-svc` (PR Backend #310)

Para evitar cualquier conflicto con `Backend #310` (`24dd02c872d444af69f86006c2a86f9aa1178246`), **no se modifica** `apps/catalog-svc/test/postgres.persistence.e2e-spec.ts` ni los archivos de CI/CD. En su lugar, se implementa la suite independiente `apps/catalog-svc/test/h5/catalog-h5-equivalence.test.mjs` usando dobles de transporte y fixtures desechables (sin RabbitMQ ni infraestructura Azure):

| Escenario histórico | Garantía verificada en `catalog-h5-equivalence.test.mjs` | Estado |
|---|---|---|
| `TAXONOMY-UPDATES` | Replay durable, ordenamiento monotónico, etiquetas vigentes preservando identidad histórica, ACK posterior al commit durable de Inbox y recuperación tras reinicio de consumidor. | `PASS / ISOLATED` |
| `BLOCK-A2` | Manejo consolidado de eventos Inventory (`completed` / `rejected`), preservación de saldos e idempotencia ante replay. | `PASS / ISOLATED` |
| `JOINT-01` | Commit atómico agregado + Outbox, correlación `requested`/`results` y deduplicación por `event_id`. | `PASS / ISOLATED` |
| `JOINT-01-REGRESSION` | Residuo previo no publicado en Outbox no puede secuestrar ni contaminar la correlación de una solicitud posterior. | `PASS / ISOLATED` |
| `BULK-JOINT` | Frontera transaccional entre Bulk importer (Outbox/Inbox) y Catalog al aplicar cambios masivos. | `PASS / ISOLATED` |
| `BULK-CONSUMER-v2` | Resolución de SKU (simple y variante) y replay idempotente sin duplicación de efectos en consumidor v2. | `PASS / ISOLATED` |
