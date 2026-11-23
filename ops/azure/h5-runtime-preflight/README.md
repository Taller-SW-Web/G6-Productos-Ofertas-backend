# G6 H5 runtime preflight for G5

This utility prepares and checks **configuration evidence only** for Gateway,
Catalog, Inventory, Pricing and Promotions. It does not deploy, create ACA
resources, change Azure, alter shared data, issue G7 grants, or apply SQL.

## Normative basis

- Runtime names and accepted values come from each service's parser in
  `apps/{api-gateway,catalog-svc,inventory-svc,pricing-svc,promotions-svc}`.
- H5 transport is Azure Service Bus Basic for internal G6 traffic. It is not
  the G5 boundary. G5 uses authenticated HTTP through APIM/Gateway.
- The H5 Azure CD procedure is
  `ops/azure/container-apps/CONFIGURACION_OIDC_H5.md`; its release input is
  `release.psv` with a single verified source SHA and one OCI digest per
  service. Placeholder SHAs/digests below are deliberately non-deployable.
- Official Docs master was fetched and read at `61726e2db227a8763fbea6d9cc055651804661c4`.

## Private parameters

The private manifest reference is:

```text
%LOCALAPPDATA%\G6\h5-runtime-preflight\parameters.private.json
```

Only the example format is versioned. Do not put `.private.json`, `.env.local`,
CA files, tokens, passwords or JWTs under the repository. Populate the private
copy from authorized owners and the final release evidence. The `ghcrPull`
token must be a dedicated, least-privilege, read-only GHCR credential. The
currently available GitHub CLI credential has broader scopes and is not copied
or reused as an ACA runtime secret.

The private copy uses the parameter names and five-app structure of the H5
ACA parameter contract in Backend #263: `environmentName`,
`environmentLocation`, `promotionsIdentityResourceId`,
`promotionsIdentityClientId`, `registryUsername`, `sourceSha`, `imageDigests`
and `appConfiguration`. Each `appConfiguration` entry has `env` and `secrets`
arrays; each app has its own secret named `ghcr-pull`, referenced by the Bicep
registry definition. Runtime passwords and client secrets are represented by
`secretRef`, never plain environment values. The private template is shaped as
an Azure deployment parameters document and remains non-deployable while SHA,
digests, package credentials and managed identity values are placeholders.

The G7 technical client `promotions-svc` is separate from the Azure managed
identity client ID in the Bicep parameters, and from the external G5 caller
`modulo-ventas`. The authorized API-productos scopes must be read from the G7
issued token/authorization record; neither the contract nor a `modulo-ventas`
token proves them. `ventas:pedidos:evidencia-cupon:leer` belongs to `api-ventas`
and remains pending separately.

## Parser-derived configuration matrix

| Service | Database and TLS | Identity | Private destinations / H5 bootstrap |
| --- | --- | --- | --- |
| Gateway | No PostgreSQL parser/dependency | `G6_SECURITY_MODE=G7_AUTHENTICATED`, `AUTH_ISSUER`, `AUTH_JWKS_URL`; technical token settings are parser-gated when used | Four required-for-this-cut private HTTPS origins: `GATEWAY_CATALOG_SVC_URL`, `GATEWAY_INVENTORY_SVC_URL`, `GATEWAY_PRICING_SVC_URL`, `GATEWAY_PROMOTIONS_SVC_URL`. Demo/public operation flags false/empty. |
| Catalog | `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGSSLMODE=verify-full`, absolute X.509 `PGSSLROOTCERT`, `G6_DATABASE_SCHEMA=catalog`, `G6_EXPECTED_ROLE` (`catalog_dev_login` or `catalog_app`), `G6_CONNECTION_MODE=session` or `direct`; login must match expected role and pooler suffix rules | `G6_SECURITY_MODE=G7_AUTHENTICATED`; `SECURITY_ISSUER`, `SECURITY_DISCOVERY_URL`, `SECURITY_JWKS_URL` when enabling G7 trust | `DATABASE_URL` is not an alternative. Keep Catalog H5/AMQP senders off until the signed release/flow is authorized. |
| Inventory | `DATABASE_URL` **or** the complete `PGHOST`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` tuple (optionally `PGPORT`); remote TLS is verified by default, `PGSSLMODE=verify-full`, optional explicit CA `PGSSLROOTCERT`; effective search path `inventory,public` | `G6_SECURITY_MODE=G7_AUTHENTICATED`, `G7_JWT_ISSUER`, `G7_JWT_JWKS_URL` | Keep `INVENTORY_CATALOG_SKU_DEACTIVATION_ENABLED=false`, public operation IDs empty and all H5 Service Bus selectors absent/off. |
| Pricing | Required PostgreSQL `DATABASE_URL`; production must include `sslmode=verify-full`; custom CA via `sslrootcert` in URL or `PGSSLROOTCERT`; TLS verification cannot be disabled; search path `pg_catalog,pricing` | `G6_SECURITY_MODE=G7_AUTHENTICATED`, paired `AUTH_ISSUER`/`AUTH_JWKS_URL`; service-token pair only when the Catalog dependency needs M2M | `PRICING_CATALOG_URL` is a private HTTPS origin. Keep Service Bus pilot/production, price-change publishing and public operation IDs off for bootstrap. |
| Promotions | `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGSSLMODE=verify-full`, absolute X.509 `PGSSLROOTCERT`, `G6_DATABASE_SCHEMA=promotions`, `G6_CONNECTION_MODE=session`; runtime login is distinct from owner | `G6_SECURITY_MODE=G7_AUTHENTICATED`, paired `AUTH_ISSUER`/`AUTH_JWKS_URL`; own token/secret pair is separate | All coupon runtime, G5 commands, general event fan-out and probes off. When using the parser's no-Rabbit path, it requires `MESSAGING_PROVIDER=AZURE_SERVICE_BUS` plus the approved namespace even if event/command flags are false; do not use a made-up `RABBITMQ_URL`. |

Database runtime group roles observed in the SQL contract are `catalog_app`,
`inventory_app`, `pricing_app` and `po_promotions_dev_runtime`; the actual
login-to-group membership is environment-specific and must be queried. The
parsers do not accept one universal PostgreSQL credential/role. Catalog has
`G6_EXPECTED_ROLE`; Inventory and Pricing do not expose that setting, so record
their expected group separately as private manifest metadata. Promotions uses
its own runtime group. The PostgreSQL host/database/login/CA values are not
present in this checkout and must come from authorized DB operations.

Never set `NODE_TLS_REJECT_UNAUTHORIZED=0`. Keep all public-operation lists
empty. Keep `GATEWAY_DEMO_NO_AUTH_ENABLED=false` and any legacy demo bypass
flags false. Configure only the actual upstream origins from the isolated ACA
environment after those apps exist; do not infer hostnames.

## Repeatable checks

1. Run `Initialize-PrivateManifest.ps1`, then
   `Invoke-Preflight.ps1 -ProbePostgres -ProbeG7Token` with the private
   parameters file after the real inputs arrive.
   It emits key names and statuses only; secret values, JWTs, CA bytes and
   connection strings are never printed.
2. Run `integration-readonly.sql` with each authorized runtime login in a
   read-only transaction and `sslmode=verify-full`. The query reports current
   login/effective role, TLS, schema/role visibility and migration marker only.
3. Verify table-level least privilege against the service's schema and model.
   For the known H5 work, do not reapply `catalog.outbox_delivery`,
   `inventory.outbox_delivery` or Promotions H5 migrations. This utility never
   runs DDL.
4. Check business fixture presence with separate read-only queries:
   `fixtures-catalog-readonly.sql`, `fixtures-inventory-readonly.sql`,
   `fixtures-pricing-readonly.sql` and `fixtures-promotions-readonly.sql`.
   Supply the approved SKU, location code, order amount, product ID and
   customer reference through `psql -v`; never print a coupon code, JWT or
   customer data. The Promotions query finds an eligible candidate under its
   local rule fields. Final G5 coupon eligibility still requires the real
   authenticated service flow and its external catalog/price evidence. This
   checkout has no authorized DB connection, so fixture status is unverified.
5. The G7 token check requires the authorized `promotions-svc` client secret.
   It is distinct from `modulo-ventas`; never request or print a JWT. A token
   issued to `modulo-ventas` cannot establish Promotions' grants.

The read-only SQL is intentionally diagnostic, not a grant/migration script. If
it finds missing privileges or DDL, prepare a separate exact proposal for DBA
review and stop there.

## Current run (2026-11-23)

- G7 discovery and JWKS were reachable over HTTPS. Discovery advertised the
  reference issuer, matching JWKS URL and `/api/v1/auth/token`; one public key
  was present. This does not prove a service credential, effective grant or
  audience/scope authorization.
- G7's authorized `promotions-svc` secret is absent from this workstation's
  runtime files; no client-credentials token request was attempted.
- The Docs contract and inter-module matrix distinguish the `api-productos`
  audience and documented scopes from effective G7 registration/grants. The
  checked-in evidence marks consumer grants as pending or requiring individual
  confirmation; no G7 authorization record or authorized token was available
  here to verify a communicated grant. In particular,
  `ventas:pedidos:evidencia-cupon:leer` is a separate pending `api-ventas`
  scope and is not treated as an `api-productos` grant.
- Azure CLI has a logged-in subscription, but read-only listing found only the
  isolated H5 managed environment and zero Container Apps in its resource
  group. No ACA provisioning or CD was run.
- Read-only Azure inspection found the H5 `Basic` namespace and the existing
  `g6-h5-int-promotions` user-assigned identity. Their resource ID, client ID
  and namespace FQDN are now in the private Bicep parameter copy. The identity
  currently has no Azure Service Bus Data Sender/Receiver role at that
  namespace; coupon commands and general event fan-out remain false. The
  namespace is in Chile Central. No resource or role assignment was changed;
  the missing data-plane grant must be resolved by the Azure resource owner
  before any Service Bus flow is enabled.
- GitHub Packages returned an empty container-package list for the organization.
  The five package tags/digests and final release SHA are unavailable. The
  existing `gh` token has broad scopes despite `read:packages`; it was not
  written into the manifest or sent to GHCR as a registry password.
- `psql` and the documented private PostgreSQL env/CA files are absent. No
  PostgreSQL login, TLS handshake, role/grant, migration, schema, or fixture
  query could be run. The parser contracts require `verify-full` for Catalog,
  Pricing and Promotions; Inventory enforces verified TLS by default for
  remote hosts and supports a configured root CA.
- No shared data was read or changed. The read-only query file is prepared for
  execution once authorized runtime credentials become available.
- The private manifest is at
  `%LOCALAPPDATA%\G6\h5-runtime-preflight\parameters.private.json`; the file
  ACL allows only the current Windows user and SYSTEM. It contains confirmed
  Azure namespace/managed identity identifiers and blank placeholders for all
  secrets and unverified runtime values.

## Scope and acceptance

Objective: reduce configuration uncertainty for the first G5 integration
bootstrap while isolating credentials from Git and shared systems.

Acceptance: an actual release SHA/digest set and least-privilege GHCR pull
credential are available; all service parser inputs validate; PostgreSQL
`verify-full`, runtime login, expected role, minimum privileges and required
schemas/migrations are evidenced; G7 public metadata and the distinct
`promotions-svc` client/grants validate without exposing tokens; four Gateway
upstreams are reachable only over the authorized private path; and a SELECT-only
fixture check finds SKU, location stock, MARKETPLACE price and an eligible
coupon. No deployment or shared-data mutation is part of acceptance.
