import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const validatorRevision = '51f8441a2adb2e0484b2a2d3072617908f9672dc';
const validatorPathInRepo = 'ops/azure/container-apps/validate-h5-five-apps.mjs';
const services = ['api-gateway', 'catalog-svc', 'inventory-svc', 'pricing-svc', 'promotions-svc'];
const root = mkdtempSync(join(tmpdir(), 'g6-h5-aca-compat-'));
const validatorSource = execFileSync('git', ['show', `${validatorRevision}:${validatorPathInRepo}`], { encoding: 'utf8' });
const validatorPath = join(root, 'validate-h5-five-apps.mjs');
writeFileSync(validatorPath, validatorSource, 'utf8');
const { validateH5AcaParameters } = await import(pathToFileURL(validatorPath));
const templatePath = new URL('./parameters.private.example.json', import.meta.url);
const template = JSON.parse(readFileSync(templatePath, 'utf8').replace(/^\uFEFF/, ''));
const caPath = join(root, 'synthetic-ca.pem');
const keyPath = join(root, 'synthetic-ca-key.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', caPath, '-days', '2', '-nodes', '-subj', '/CN=h5-preflight-synthetic-ca', '-addext', 'basicConstraints=critical,CA:TRUE'], { stdio: 'ignore' });
const syntheticCa = readFileSync(caPath, 'utf8');
const sha = 'a'.repeat(40);
const digest = `sha256:${'b'.repeat(64)}`;

function validParameters() {
  const document = structuredClone(template);
  document.parameters.environmentLocation.value = 'Brazil South';
  document.parameters.promotionsIdentityResourceId.value = '/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/preflight/providers/Microsoft.ManagedIdentity/userAssignedIdentities/promotions';
  document.parameters.promotionsIdentityClientId.value = '00000000-0000-0000-0000-000000000002';
  document.parameters.registryUsername.value = 'synthetic-ghcr-user';
  document.parameters.sourceSha.value = sha;
  for (const service of services) document.parameters.imageDigests.value[service] = digest;
  const apps = document.parameters.appConfiguration.value;
  for (const [service, app] of Object.entries(apps)) {
    for (const secret of app.secrets) {
      secret.value = secret.name === 'postgres-ca' ? syntheticCa : `synthetic-${secret.name}`;
    }
    const values = Object.fromEntries(app.env.map((entry) => [entry.name, entry.value ?? '']));
    if (service === 'api-gateway') {
      for (const upstream of ['CATALOG', 'INVENTORY', 'PRICING', 'PROMOTIONS']) {
        values[`GATEWAY_${upstream}_SVC_URL`] = `https://${upstream.toLowerCase()}-svc.internal.preflight.test`;
      }
    } else if (service === 'catalog-svc') {
      Object.assign(values, { PGHOST: 'postgres.test', PGPORT: '5432', PGDATABASE: 'catalog', PGUSER: 'catalog_app', G6_EXPECTED_ROLE: 'catalog_app', G6_CONNECTION_MODE: 'session' });
    } else if (service === 'inventory-svc') {
      Object.assign(values, { PGHOST: 'postgres.test', PGPORT: '5432', PGDATABASE: 'inventory', PGUSER: 'inventory_app' });
    } else if (service === 'pricing-svc') {
      values.PGSSLROOTCERT = '/etc/ssl/postgres/ca.crt';
      values.PRICING_CATALOG_URL = 'https://catalog-svc.internal.preflight.test';
      const dbUrl = app.secrets.find((secret) => secret.name === 'pricing-database-url');
      dbUrl.value = 'postgresql://pricing_app:synthetic-password@postgres.test:5432/pricing?sslmode=verify-full';
    } else {
      Object.assign(values, { PGHOST: 'postgres.test', PGPORT: '5432', PGDATABASE: 'promotions', PGUSER: 'promotions_app', G6_DATABASE_SCHEMA: 'promotions', G6_CONNECTION_MODE: 'session' });
    }
    app.env = app.env.map((entry) => entry.secretRef ? entry : { ...entry, value: values[entry.name] ?? entry.value });
  }
  return document;
}

test.after(() => rmSync(root, { recursive: true, force: true }));

test('completed synthetic manifest is accepted by PR #263 validator', () => {
  const document = validParameters();
  assert.deepEqual(
    validateH5AcaParameters(document, { authorizedSha: sha, environmentDefaultDomain: 'preflight.test' }),
    { sourceSha: sha, services },
  );
});

test('rejects a guarded environment variable duplicated in appConfiguration.env', () => {
  const document = validParameters();
  document.parameters.appConfiguration.value['api-gateway'].env.push({ name: 'NODE_ENV', value: 'production' });
  assert.throws(() => validateH5AcaParameters(document, { authorizedSha: sha, environmentDefaultDomain: 'preflight.test' }), /ENVIRONMENT_RESERVED_API_GATEWAY/);
});

test('rejects missing, empty, and invalid postgres-ca secrets', () => {
  for (const mode of ['missing', 'empty', 'invalid']) {
    const document = validParameters();
    const catalog = document.parameters.appConfiguration.value['catalog-svc'];
    const ca = catalog.secrets.find((secret) => secret.name === 'postgres-ca');
    if (mode === 'missing') catalog.secrets = catalog.secrets.filter((secret) => secret.name !== 'postgres-ca');
    if (mode === 'empty') ca.value = '';
    if (mode === 'invalid') ca.value = 'not a PEM certificate';
    assert.throws(() => validateH5AcaParameters(document, { authorizedSha: sha, environmentDefaultDomain: 'preflight.test' }), /POSTGRES_CA_INVALID_CATALOG_SVC|SECRET_INVALID_CATALOG_SVC/);
  }
});

test('also accepts the current master validator after #263 is integrated', async (context) => {
  let currentSource;
  try {
    currentSource = execFileSync('git', ['show', `origin/master:${validatorPathInRepo}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    context.skip('#263 validator is not present in origin/master yet');
    return;
  }
  const currentPath = join(root, 'validate-h5-five-apps-master.mjs');
  writeFileSync(currentPath, currentSource, 'utf8');
  const currentValidator = await import(pathToFileURL(currentPath));
  const document = validParameters();
  assert.deepEqual(
    currentValidator.validateH5AcaParameters(document, { authorizedSha: sha, environmentDefaultDomain: 'preflight.test' }),
    { sourceSha: sha, services },
  );
  document.parameters.appConfiguration.value['api-gateway'].env.push({ name: 'NODE_ENV', value: 'production' });
  assert.throws(
    () => currentValidator.validateH5AcaParameters(document, { authorizedSha: sha, environmentDefaultDomain: 'preflight.test' }),
    /ENVIRONMENT_RESERVED_API_GATEWAY/,
  );
});
