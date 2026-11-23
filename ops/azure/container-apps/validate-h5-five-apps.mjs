import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { X509Certificate } from 'node:crypto';

export const SERVICES = Object.freeze([
  'api-gateway',
  'catalog-svc',
  'inventory-svc',
  'pricing-svc',
  'promotions-svc',
]);
export const OFFICIAL_REPOSITORY = 'Taller-SW-Web/G6-Productos-Ofertas-backend';
export const OFFICIAL_CI_WORKFLOW = '.github/workflows/ci.yml';

const RESERVED_ENV = new Set([
  'NODE_ENV',
  'API_GATEWAY_PORT',
  'G6_SECURITY_MODE',
  'GATEWAY_DEMO_NO_AUTH_ENABLED',
  'GATEWAY_G5_H5_ENABLED',
  'CATALOG_SVC_PORT',
  'INVENTORY_SVC_PORT',
  'INVENTORY_DEMO_NO_AUTH_ENABLED',
  'INVENTORY_CATALOG_SKU_DEACTIVATION_ENABLED',
  'PRICING_SVC_PORT',
  'PRICING_PRICE_CHANGED_PUBLISH_ENABLED',
  'PROMOTIONS_SVC_PORT',
  'PROMOTIONS_COUPON_RUNTIME_ENABLED',
  'PROMOTIONS_H5_COUPON_COMMANDS_ENABLED',
  'MESSAGING_PROVIDER',
  'SERVICE_BUS_NAMESPACE_FQDN',
  'PROMOTIONS_SERVICE_BUS_EVENTS_ENABLED',
  'G6_SERVICE_BUS_PRODUCTION_ENABLED',
  'AZURE_CLIENT_ID',
]);

function fail(code) {
  throw new Error(`H5_ACA_VALIDATION_${code}`);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return (
    isRecord(value) &&
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function parameterValue(parameters, name) {
  const entry = parameters?.[name];
  if (!isRecord(entry) || !Object.hasOwn(entry, 'value'))
    fail(`PARAMETER_MISSING_${name.toUpperCase()}`);
  return entry.value;
}

const REQUIRED_ENV = Object.freeze({
  'api-gateway': ['AUTH_ISSUER', 'AUTH_JWKS_URL', 'GATEWAY_CATALOG_SVC_URL', 'GATEWAY_INVENTORY_SVC_URL', 'GATEWAY_PRICING_SVC_URL', 'GATEWAY_PROMOTIONS_SVC_URL'],
  'catalog-svc': ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGSSLMODE', 'PGSSLROOTCERT', 'G6_DATABASE_SCHEMA', 'G6_EXPECTED_ROLE', 'G6_CONNECTION_MODE', 'SECURITY_ISSUER', 'SECURITY_DISCOVERY_URL', 'SECURITY_JWKS_URL'],
  'inventory-svc': ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGSSLMODE', 'PGSSLROOTCERT', 'G7_JWT_ISSUER', 'G7_JWT_JWKS_URL'],
  'pricing-svc': ['DATABASE_URL', 'PGSSLROOTCERT', 'AUTH_ISSUER', 'AUTH_JWKS_URL'],
  'promotions-svc': ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGSSLMODE', 'PGSSLROOTCERT', 'G6_DATABASE_SCHEMA', 'G6_CONNECTION_MODE', 'AUTH_ISSUER', 'AUTH_JWKS_URL'],
});

export function validateH5AcaParameters(document, { authorizedSha, environmentDefaultDomain } = {}) {
  if (!isRecord(document) || !isRecord(document.parameters))
    fail('PARAMETER_FILE_INVALID');

  const parameters = document.parameters;
  const sourceSha = parameterValue(parameters, 'sourceSha');
  if (typeof sourceSha !== 'string' || !/^[a-fA-F0-9]{40}$/.test(sourceSha))
    fail('SOURCE_SHA_FORMAT');
  if (!/^[a-f0-9]{40}$/i.test(authorizedSha ?? '') || sourceSha.toLowerCase() !== authorizedSha.toLowerCase())
    fail('SOURCE_SHA_NOT_AUTHORIZED');
  if (typeof parameterValue(parameters, 'registryUsername') !== 'string' || !parameterValue(parameters, 'registryUsername').trim()) fail('GHCR_USERNAME_REQUIRED');

  const digests = parameterValue(parameters, 'imageDigests');
  if (!exactKeys(digests, SERVICES))
    fail('SERVICE_SET_IMAGE_DIGESTS');
  for (const service of SERVICES) {
    if (
      typeof digests[service] !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(digests[service])
    )
      fail(`IMAGE_DIGEST_INVALID_${service.toUpperCase().replaceAll('-', '_')}`);
  }

  const appConfiguration = parameterValue(parameters, 'appConfiguration');
  if (!exactKeys(appConfiguration, SERVICES))
    fail('SERVICE_SET_CONFIGURATION');

  for (const service of SERVICES) {
    const app = appConfiguration[service];
    if (
      !exactKeys(app, ['env', 'secrets']) ||
      !Array.isArray(app.env) ||
      app.env.length === 0 ||
      !Array.isArray(app.secrets)
    )
      fail(`CONFIGURATION_INCOMPLETE_${service.toUpperCase().replaceAll('-', '_')}`);

    const secretNames = new Set();
    for (const secret of app.secrets) {
      if (
        !exactKeys(secret, ['name', 'value']) ||
        typeof secret.name !== 'string' ||
        !/^[a-z][a-z0-9-]{0,62}$/.test(secret.name) ||
        typeof secret.value !== 'string' ||
        secret.value.length === 0
      )
        fail(`SECRET_INVALID_${service.toUpperCase().replaceAll('-', '_')}`);
      const normalizedName = secret.name.toLowerCase();
      if (secretNames.has(normalizedName))
        fail(`SECRET_NAME_DUPLICATE_${service.toUpperCase().replaceAll('-', '_')}`);
      if (normalizedName === 'edge-config') fail('SECRET_EDGE_CONFIG_RESERVED');
      secretNames.add(normalizedName);
    }
    if (!secretNames.has('ghcr-pull')) fail(`GHCR_PULL_SECRET_MISSING_${service.toUpperCase().replaceAll('-', '_')}`);
    if (service !== 'api-gateway') {
      const caSecret = app.secrets.find((entry) => entry.name.toLowerCase() === 'postgres-ca');
      try { new X509Certificate(caSecret?.value ?? ''); } catch { fail(`POSTGRES_CA_INVALID_${service.toUpperCase().replaceAll('-', '_')}`); }
    }

    const environmentNames = new Set();
    for (const env of app.env) {
      const hasValue = exactKeys(env, ['name', 'value']);
      const hasSecretRef = exactKeys(env, ['name', 'secretRef']);
      if (
        (!hasValue && !hasSecretRef) ||
        typeof env.name !== 'string' ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(env.name)
      )
        fail(`ENVIRONMENT_INVALID_${service.toUpperCase().replaceAll('-', '_')}`);
      const normalizedName = env.name.toUpperCase();
      if (environmentNames.has(normalizedName))
        fail(`ENVIRONMENT_NAME_DUPLICATE_${service.toUpperCase().replaceAll('-', '_')}`);
      if (RESERVED_ENV.has(normalizedName))
        fail(`ENVIRONMENT_RESERVED_${service.toUpperCase().replaceAll('-', '_')}`);
      environmentNames.add(normalizedName);
      if (hasValue && typeof env.value !== 'string')
        fail(`ENVIRONMENT_VALUE_INVALID_${service.toUpperCase().replaceAll('-', '_')}`);
      if (
        hasSecretRef &&
        (typeof env.secretRef !== 'string' ||
          !secretNames.has(env.secretRef.toLowerCase()))
      )
        fail(`SECRET_REFERENCE_INVALID_${service.toUpperCase().replaceAll('-', '_')}`);
    }
    for (const requiredName of REQUIRED_ENV[service]) {
      if (!environmentNames.has(requiredName)) fail(`EFFECTIVE_CONFIGURATION_MISSING_${service.toUpperCase().replaceAll('-', '_')}_${requiredName}`);
    }
    if (['catalog-svc','inventory-svc','promotions-svc'].includes(service) && !app.env.some((entry) => entry.name.toUpperCase() === 'PGPASSWORD' && entry.secretRef)) fail(`DATABASE_PASSWORD_MUST_USE_SECRET_${service.toUpperCase().replaceAll('-', '_')}`);
    if (service === 'pricing-svc' && !app.env.some((entry) => entry.name.toUpperCase() === 'DATABASE_URL' && entry.secretRef)) fail('DATABASE_URL_MUST_USE_SECRET_PRICING_SVC');
    const secretValues = new Map(app.secrets.map((entry) => [entry.name.toLowerCase(), entry.value]));
    const envValues = new Map(app.env.map((entry) => [entry.name.toUpperCase(), entry.value ?? secretValues.get(entry.secretRef?.toLowerCase())]));
    if (service === 'pricing-svc' && (!String(envValues.get('DATABASE_URL') ?? '').includes('sslmode=verify-full') || envValues.get('PGSSLROOTCERT') !== '/etc/ssl/postgres/ca.crt')) fail('DATABASE_TLS_REQUIRED_PRICING_SVC');
    if (['catalog-svc', 'inventory-svc', 'promotions-svc'].includes(service) && (envValues.get('PGSSLMODE') !== 'verify-full' || envValues.get('PGSSLROOTCERT') !== '/etc/ssl/postgres/ca.crt')) fail(`DATABASE_TLS_REQUIRED_${service.toUpperCase().replaceAll('-', '_')}`);
    if (service === 'catalog-svc' && (envValues.get('G6_DATABASE_SCHEMA') !== 'catalog' || !['catalog_app','catalog_dev_login'].includes(envValues.get('G6_EXPECTED_ROLE')) || !['session','direct'].includes(envValues.get('G6_CONNECTION_MODE')))) fail('CATALOG_DATABASE_CONFIGURATION_INVALID');
    if (service === 'catalog-svc' && (!String(envValues.get('PGUSER')).startsWith(`${envValues.get('G6_EXPECTED_ROLE')}.`) && envValues.get('PGUSER') !== envValues.get('G6_EXPECTED_ROLE'))) fail('CATALOG_DATABASE_ROLE_INVALID');
    if (service === 'promotions-svc' && (envValues.get('G6_DATABASE_SCHEMA') !== 'promotions' || envValues.get('G6_CONNECTION_MODE') !== 'session')) fail('PROMOTIONS_DATABASE_CONFIGURATION_INVALID');
    if (service === 'promotions-svc' && app.env.some((entry) => entry.name.toUpperCase() === 'RABBITMQ_URL')) fail('PROMOTIONS_DUAL_BROKER_FORBIDDEN');
    for (const [name, app] of Object.entries({ GATEWAY_CATALOG_SVC_URL:'catalog-svc', GATEWAY_INVENTORY_SVC_URL:'inventory-svc', GATEWAY_PRICING_SVC_URL:'pricing-svc', GATEWAY_PROMOTIONS_SVC_URL:'promotions-svc' })) {
      if (service === 'api-gateway' && (!environmentDefaultDomain || envValues.get(name) !== `https://${app}.internal.${environmentDefaultDomain}`)) fail(`PRIVATE_ORIGIN_INVALID_${name}`);
    }
  }

  return Object.freeze({ sourceSha, services: SERVICES });
}

export function verifyGitHubSourceEvidence({ repositoryFullName, selectedSha, masterSha, workflowRun }) {
  if (repositoryFullName !== OFFICIAL_REPOSITORY) fail('SOURCE_REPOSITORY_NOT_OFFICIAL');
  if (!/^[a-f0-9]{40}$/i.test(selectedSha ?? '') || selectedSha.toLowerCase() !== masterSha?.toLowerCase()) fail('SOURCE_SHA_NOT_CURRENT_MASTER');
  if (workflowRun?.path !== OFFICIAL_CI_WORKFLOW || workflowRun?.head_sha?.toLowerCase() !== selectedSha.toLowerCase() || workflowRun?.event !== 'push' || workflowRun?.head_branch !== 'master' || workflowRun?.status !== 'completed' || workflowRun?.conclusion !== 'success') fail('SOURCE_CI_PUSH_NOT_SUCCESSFUL');
  return true;
}

export function verifyOciImageEvidence({ service, digest, sourceSha, manifest }) {
  if (!SERVICES.includes(service) || !/^sha256:[a-f0-9]{64}$/.test(digest ?? '') ||
    manifest?.digest !== digest || manifest?.labels?.['org.opencontainers.image.revision']?.toLowerCase() !== sourceSha?.toLowerCase() ||
    manifest?.labels?.['org.opencontainers.image.source'] !== 'https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend' ||
    manifest?.labels?.['org.opencontainers.image.title'] !== service) fail(`OCI_SOURCE_MISMATCH_${service}`);
  return true;
}

export async function verifyRemoteEvidence(document, sourceSha, fetchImpl = fetch, env = process.env) {
  const github = `https://api.github.com/repos/${OFFICIAL_REPOSITORY}`;
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const masterResponse = await fetchImpl(`${github}/commits/master`, { headers });
  if (!masterResponse.ok) fail('GITHUB_MASTER_LOOKUP_FAILED');
  const master = await masterResponse.json();
  const runsResponse = await fetchImpl(`${github}/actions/runs?head_sha=${sourceSha}&event=push&status=completed`, { headers });
  if (!runsResponse.ok) fail('GITHUB_CI_LOOKUP_FAILED');
  const runs = await runsResponse.json();
  const workflowRun = runs.workflow_runs?.find((run) => run.path === OFFICIAL_CI_WORKFLOW && run.head_sha === sourceSha && run.event === 'push' && run.status === 'completed' && run.conclusion === 'success' && run.head_branch === 'master');
  verifyGitHubSourceEvidence({ repositoryFullName:OFFICIAL_REPOSITORY, selectedSha: sourceSha, masterSha: master.sha, workflowRun });

  const username = env.GHCR_READ_USERNAME;
  const password = env.GHCR_READ_TOKEN;
  if (!username || !password) fail('GHCR_READ_CREDENTIALS_REQUIRED');
  if (username !== document.parameters.registryUsername.value) fail('GHCR_USERNAME_CONFIGURATION_MISMATCH');
  for (const service of SERVICES) {
    const pullSecret = document.parameters.appConfiguration.value[service].secrets.find((secret) => secret.name.toLowerCase() === 'ghcr-pull');
    if (pullSecret?.value !== password) fail(`GHCR_PULL_SECRET_CONFIGURATION_MISMATCH_${service.toUpperCase().replaceAll('-', '_')}`);
    const digest = document.parameters.imageDigests.value[service];
    const repo = `taller-sw-web/g6-productos-ofertas-backend/${service}`;
    const encoded = Buffer.from(`${username}:${password}`).toString('base64');
    const tokenResponse = await fetchImpl(`https://ghcr.io/token?scope=repository:${repo}:pull`, { headers: { Authorization: `Basic ${encoded}` } });
    if (!tokenResponse.ok) fail(`GHCR_AUTHORIZATION_FAILED_${service.toUpperCase().replaceAll('-', '_')}`);
    const tokenDocument = await tokenResponse.json();
    if (!tokenDocument.token) fail('GHCR_TOKEN_RESPONSE_INVALID');
    const imageResponse = await fetchImpl(`https://ghcr.io/v2/${repo}/manifests/${digest}`, { headers: { Authorization: `Bearer ${tokenDocument.token}`, Accept: 'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' } });
    if (!imageResponse.ok) fail(`GHCR_MANIFEST_UNAVAILABLE_${service.toUpperCase().replaceAll('-', '_')}`);
    const manifest = await imageResponse.json();
    if (imageResponse.headers.get('docker-content-digest') !== digest) fail(`GHCR_DIGEST_MISMATCH_${service.toUpperCase().replaceAll('-', '_')}`);
    const configResponse = await fetchImpl(`https://ghcr.io/v2/${repo}/blobs/${manifest.config?.digest}`, { headers: { Authorization: `Bearer ${tokenDocument.token}` } });
    if (!configResponse.ok) fail(`GHCR_CONFIG_UNAVAILABLE_${service.toUpperCase().replaceAll('-', '_')}`);
    const config = await configResponse.json();
    verifyOciImageEvidence({ service, digest, sourceSha, manifest: { digest: imageResponse.headers.get('docker-content-digest'), labels: config.config?.Labels ?? {} } });
  }
  return true;
}

async function main() {
  const [, , parameterFile] = process.argv;
  if (!parameterFile) fail('USAGE');
  const document = JSON.parse(readFileSync(parameterFile, 'utf8'));
  const result = validateH5AcaParameters(document, { authorizedSha: process.env.H5_AUTHORIZED_SOURCE_SHA, environmentDefaultDomain: process.env.H5_ENVIRONMENT_DEFAULT_DOMAIN });
  await verifyRemoteEvidence(document, result.sourceSha);
  process.stdout.write(
    `H5 ACA parameters valid: ${result.services.length} services, SHA ${result.sourceSha}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'H5_ACA_VALIDATION_FAILED'}\n`,
    );
    process.exitCode = 1;
  });
}
