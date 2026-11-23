# Preflight de runtime H5 para G5

Utilidades de preparación y comprobación de parámetros para Gateway, Catalog,
Inventory, Pricing y Promotions. El preflight es de solo lectura en Azure y
PostgreSQL. No crea ACA, ejecuta CD, modifica grants, aplica SQL ni cambia datos.

## Contratos revisados

- Backend `master` actualizado: `7fb3fcb380f106bfa58f6c39976c7681ca5fe32b`.
- Interfaz y `guardedEnv` verificados contra #263 HEAD
  `51f8441a2adb2e0484b2a2d3072617908f9672dc`. El validador no fue modificado.
- Docs `master`: `490172c11cb4b83ddd1996f8d5834d0402184cf8`; los seis contratos
  H5 revisados no cambiaron respecto a la lectura anterior.
- H5 Service Bus Basic es mensajería entre bounded contexts G6; G5 consume por
  HTTP autenticado a través de APIM/Gateway. La plantilla de bootstrap conserva
  las banderas comerciales y de eventos deshabilitadas.

## Manifiesto y CA

`parameters.private.example.json` conserva los parámetros ARM y cinco entradas
`appConfiguration` que requiere #263. No incluye ninguna variable de
`RESERVED_ENV`: esas variables se agregan exclusivamente desde `guardedEnv` del
Bicep. El preflight compara nombres y valores del Bicep con el baseline
aprobado, detecta duplicados y no declara configuración efectiva `PASS` si el
manifiesto está incompleto o sería rechazado por #263.

Catalog, Inventory, Pricing y Promotions contienen un secreto `postgres-ca`
con el PEM completo. El único valor de entorno `PGSSLROOTCERT` es
`/etc/ssl/postgres/ca.crt`, que el Bicep monta desde ese secreto. Para las
pruebas locales, el preflight valida el X.509, escribe un PEM temporal con ACL
restringida solo durante `psql`, establece `PGSSLMODE=verify-full`, y restaura
las variables y elimina el temporal en `finally`. Nunca traslada una ruta de
Windows al parámetro ACA.

Los secretos, CA, `.env.local`, token GHCR y JWT permanecen fuera de Git. La
copia privada del manifiesto está en:

```text
%LOCALAPPDATA%\G6\h5-runtime-preflight\parameters.private.json
```

Inicializar/restringir la copia:

```powershell
pwsh -NoProfile -File ops/azure/h5-runtime-preflight/Initialize-PrivateManifest.ps1
```

El ejemplo es intencionalmente incompleto; reemplazar todos los placeholders
con credenciales autorizadas, SHA/digests finales y valores del entorno. Las
URLs internas deben usar exactamente `https://<app>.internal.<defaultDomain>`
del Managed Environment existente.

## Matriz de variables

| Servicio | Entradas parser/entorno no reservadas | Requisitos verificados |
|---|---|---|
| Gateway | `AUTH_ISSUER`, `AUTH_JWKS_URL`, cuatro `GATEWAY_*_SVC_URL`, lista vacía `GATEWAY_PUBLIC_OPERATION_IDS`; secreto de cliente solo si el modo técnico lo requiere | Cuatro orígenes HTTPS comparados con el default domain del Environment; seguridad G7, bypass y puertos reservados contrastados con `guardedEnv`. |
| Catalog | `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` por `secretRef`, `PGSSLMODE`, `PGSSLROOTCERT`, `G6_DATABASE_SCHEMA`, `G6_EXPECTED_ROLE`, `G6_CONNECTION_MODE`, `SECURITY_ISSUER`, `SECURITY_DISCOVERY_URL`, `SECURITY_JWKS_URL` | `verify-full`, CA X.509, esquema `catalog`, rol permitido por parser y login coherente. La tabla de entrega de mensajería se verifica solo al habilitar esa integración. |
| Inventory | `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` por `secretRef`, `PGSSLMODE`, `PGSSLROOTCERT`, `G7_JWT_ISSUER`, `G7_JWT_JWKS_URL`, lista pública vacía | TLS verificado, CA X.509, login/rol efectivo `inventory_app` y esquema HTTP requerido por el runtime. `outbox_delivery` es aparte y no bloquea HTTP cuando el transporte H5 está apagado. |
| Pricing | `DATABASE_URL` por `secretRef`, `PGSSLMODE`, `PGSSLROOTCERT`, `AUTH_ISSUER`, `AUTH_JWKS_URL`, `PRICING_CATALOG_URL`, lista pública vacía | `sslmode=verify-full`, CA X.509, origen Catalog privado y tablas/columnas que exige `PricingDatabase.check()`. `pricing.outbox_delivery` no se exige con publicación deshabilitada. |
| Promotions | `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` por `secretRef`, `PGSSLMODE`, `PGSSLROOTCERT`, `G6_DATABASE_SCHEMA`, `G6_CONNECTION_MODE`, `AUTH_ISSUER`, `AUTH_JWKS_URL`, secretos de cliente G7 | TLS verificado, CA X.509, esquema `promotions`, modo `session`; rol runtime esperado `po_promotions_dev_runtime`. Las tablas de comandos H5 solo se requieren al activar el flujo correspondiente. |

Los nombres reservados (incluyendo `NODE_ENV`, puertos, modo de seguridad,
Service Bus, identidad administrada y flags protegidos) no deben añadirse a
`appConfiguration.env`; sus valores efectivos son exactamente los que entrega
la plantilla #263. En el bootstrap inicial quedan cerrados bypass demo,
operaciones públicas, fan-out, publicación Pricing y comandos comerciales de
Promotions.

## Comprobaciones repetibles

```powershell
pwsh -NoProfile -File ops/azure/h5-runtime-preflight/Test-H5RuntimePreflight.ps1
node --test ops/azure/h5-runtime-preflight/h5-aca-compatibility.test.mjs
pwsh -NoProfile -File ops/azure/h5-runtime-preflight/Test-Postgres17.ps1
pwsh -NoProfile -File ops/azure/h5-runtime-preflight/Invoke-Preflight.ps1 -ProbePostgres -ProbeG7Token -ProbeGhcr
```

El test Node carga `validateH5AcaParameters()` desde el SHA de #263 y completa
el ejemplo con identidades, secretos, CA y digests sintéticos. Acepta el caso
positivo y prueba rechazos de variable reservada y CA ausente/vacía/inválida.
Las pruebas PowerShell cubren valores `guardedEnv`, colisiones, X.509, cleanup
TLS, estados RBAC/GHCR, tablas H5 opcionales y firma JWT simulada. El test de
PostgreSQL crea y elimina un contenedor PostgreSQL 17 desechable; valida que los
SQL de conexión, readiness y fixtures sean ejecutables. No usa datos ni
credenciales compartidos.

Si #263 aún no está integrado en el checkout, pasar a `Invoke-Preflight.ps1`
un archivo temporal de `h5-isolated-five-apps.bicep` extraído del SHA aprobado
de #263 mediante `-BicepTemplatePath`. Sin plantilla local, el check queda
`UNAVAILABLE`, nunca `PASS`.

### SQL y alcance de arranque

`integration-readonly.sql` verifica conexión/TLS, login, membresía del rol y
uso del esquema; no exige tablas H5 ni grants DML a todos los servicios.
Catalog, Inventory y Pricing tienen consultas separadas para las relaciones
que sus chequeos HTTP de arranque/readiness realmente requieren. Las tablas y
permisos de Outbox/Inbox pertenecen a la preparación adicional del flujo H5.
En particular, la ausencia de `pricing.outbox_delivery` no bloquea HTTP si la
publicación de cambios está deshabilitada. Ningún script aplica DDL.

Los cuatro `fixtures-*-readonly.sql` son consultas de presencia y devuelven
booleanos. Solo deben ejecutarse con SKU, ubicación, importe, producto y
referencia de cliente aprobados, usando login autorizado y transacción de solo
lectura. No imprimen códigos de cupón ni datos del cliente. El esquema sintético
de PostgreSQL 17 valida ejecutabilidad, no la presencia de fixtures reales.

## G7, GHCR y Service Bus

- G7 discovery/JWKS se consulta públicamente. Si existe el secreto autorizado
  `promotions-svc`, el probe valida firma criptográfica RS256/ES256 con JWKS,
  issuer, expiración, audiencia `api-productos`, cliente y scopes contra los
  `x-required-scope` del OpenAPI de Docs `master`. Un token de `api-ventas` no
  se acepta como concesión `api-productos`; el scope
  `ventas:pedidos:evidencia-cupon:leer` sigue pendiente para `api-ventas`.
  Sin credencial, el token queda `NOT_RUN`.
- GHCR usa únicamente el `ghcr-pull` dedicado del manifiesto privado. Nunca usa
  la sesión amplia de `gh`. Reporta `NO_VISIBILITY` si el registro deniega
  lectura, `MISSING_FOR_RELEASE_SHA` si hay visibilidad pero no se verifica la
  imagen del SHA/digest solicitado, y `VERIFIED` solo al validar digest y
  etiquetas OCI. Sin credencial o release final queda `NOT_RUN`; un inventario
  vacío de paquetes no se toma como prueba de que nunca fueron publicados.
- El probe Azure obtiene primero el ID de la cola real
  `g6.promotions.commands` y consulta RBAC en ese scope exacto con
  `--include-inherited`, filtrando el principal de la identidad administrada
  existente. Los estados son `PASS`, `MISSING`, `UNAVAILABLE` y `NOT_RUN`.
  No crea ni amplía asignaciones.

## Ejecución real observada (2026-11-23)

- `h5-aca-effective-configuration`: `PENDING`, por SHA/digests, pull
  credential, upstream/configuración runtime y CA/credenciales vacías del
  manifiesto privado. No declara `PASS` mientras #263 lo rechazaría.
- Bicep `guardedEnv`, los cinco parsers G7, discovery/JWKS, dominio privado,
  cuatro upstreams Gateway, dependencia Pricing→Catalog, Managed Identity y
  RBAC de `g6.promotions.commands`: `PASS`.
- RBAC se verificó con ID de cola obtenido por Azure CLI y asignaciones
  heredadas: Data Sender y Data Receiver existen para el principal Promotions
  en scope de la cola. No se hizo cambio en Service Bus.
- El Environment existente `env-g6-h5-int` está en Brazil South; el resource
  group no contiene ACA. No se aprovisionó ni ejecutó CD.
- PostgreSQL real queda `PENDING`: faltan credenciales y CA privados; no se
  hicieron conexiones ni se inspeccionaron grants, schemas, migraciones o
  fixtures compartidos. El test en PostgreSQL 17.6 desechable pasó las
  consultas SQL; Catalog/Inventory `outbox_delivery` y las tablas H5 de
  Promotions no se reaplicaron.
- G7 public discovery/JWKS: `PASS`; el cliente `promotions-svc` no tiene secreto
  autorizado local, así que el token es `NOT_RUN`. No se infiere ningún grant.
- GHCR queda `NOT_RUN`: falta credencial dedicada y SHA/digests finales. Hay
  evidencia histórica de publicaciones de Catalog y Pricing, pero no se
  comprobó el release solicitado para los cinco servicios.
- No se consultaron ni alteraron fixtures comerciales reales. El estado de
  SKU, stock, precio MARKETPLACE y cupón apto sigue sin verificar.
- Manifiesto privado actualizado fuera del repositorio; ACL restringida a la
  cuenta local y SYSTEM. Ningún secreto/CA/JWT quedó versionado.

## Dependencias externas restantes

| Owner | Operación afectada | Desbloqueo verificable |
|---|---|---|
| Release/CI Backend | Pull de las cinco imágenes | Publicar release final con SHA maestro exacto, cinco digests inmutables y etiquetas OCI coherentes. |
| GHCR owner | `ghcr-pull` | Entregar credencial dedicada de solo lectura `read:packages`; validar cada paquete/digest. |
| Operaciones PostgreSQL | Arranque HTTP y readiness SQL | Entregar host/base/login/secretos/CA por servicio; ejecutar `verify-full`, roles y consultas de readiness de solo lectura. |
| G7 Seguridad | Token y autorización `promotions-svc` | Proveer secreto técnico y evidencia token firmado con `api-productos` y scopes contractuales. La concesión `ventas:pedidos:evidencia-cupon:leer` sigue aparte para `api-ventas`. |
| G5/owners de fixtures | Preflight comercial autenticado | Confirmar contexto de prueba y fixture; ejecutar las cuatro consultas read-only y el flujo real autorizado. |

No se requiere un grant Azure adicional para el principal Promotions en la cola
consultada. Los flags comerciales continúan cerrados en el primer bootstrap.
