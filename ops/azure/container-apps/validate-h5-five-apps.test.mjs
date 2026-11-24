import assert from 'node:assert/strict';
import test from 'node:test';
import { rootCertificates } from 'node:tls';
import { SERVICES, OFFICIAL_REPOSITORY, OFFICIAL_CI_WORKFLOW, validateH5AcaParameters, verifyGitHubSourceEvidence, verifyOciImageEvidence, verifyRemoteEvidence } from './validate-h5-five-apps.mjs';

const sha = 'fcf3dd983f5436221670e8c6a113fdd15cb76de9';
const digest = `sha256:${'a'.repeat(64)}`;
const pg = [
  { name: 'PGHOST', value: 'db.internal' }, { name: 'PGPORT', value: '5432' },
  { name: 'PGDATABASE', value: 'g6' }, { name: 'PGUSER', value: 'catalog_app' },
  { name: 'PGPASSWORD', secretRef: 'runtime-password' }, { name: 'PGSSLMODE', value: 'verify-full' },
  { name: 'PGSSLROOTCERT', value: '/etc/ssl/postgres/ca.crt' },
];
const https = (name, value) => ({ name, value });

function validParameters() {
  const configs = {
    'api-gateway': [https('AUTH_ISSUER','https://identity.example/issuer'), https('AUTH_JWKS_URL','https://identity.example/jwks'), ...['CATALOG','INVENTORY','PRICING','PROMOTIONS'].map((name) => https(`GATEWAY_${name}_SVC_URL`,`https://${name.toLowerCase()}-svc.internal.env.example`))],
    'catalog-svc': [...pg, https('G6_DATABASE_SCHEMA','catalog'), https('G6_EXPECTED_ROLE','catalog_app'), https('G6_CONNECTION_MODE','session'), https('SECURITY_ISSUER','https://identity.example/issuer'), https('SECURITY_DISCOVERY_URL','https://identity.example/.well-known/openid-configuration'), https('SECURITY_JWKS_URL','https://identity.example/jwks')],
    'inventory-svc': [...pg, https('G7_JWT_ISSUER','https://identity.example/issuer'), https('G7_JWT_JWKS_URL','https://identity.example/jwks')],
    'pricing-svc': [{ name: 'DATABASE_URL', secretRef: 'runtime-password' }, https('PGSSLROOTCERT','/etc/ssl/postgres/ca.crt'), https('AUTH_ISSUER','https://identity.example/issuer'), https('AUTH_JWKS_URL','https://identity.example/jwks')],
    'promotions-svc': [...pg, https('G6_DATABASE_SCHEMA','promotions'), https('G6_CONNECTION_MODE','session'), https('AUTH_ISSUER','https://identity.example/issuer'), https('AUTH_JWKS_URL','https://identity.example/jwks')],
  };
  const appConfiguration = Object.fromEntries(SERVICES.map((service) => [service, {
    env: configs[service], secrets: [
      { name: 'runtime-password', value: service === 'pricing-svc' ? 'postgresql://u:p@db.example/g6?sslmode=verify-full' : 'private-value' },
      { name: 'ghcr-pull', value: 'never-log' },
      ...(service === 'api-gateway' ? [] : [{ name: 'postgres-ca', value: rootCertificates[0] }]),
    ],
  }]));
  return { parameters: { sourceSha: { value: sha }, registryUsername:{value:'fixture'}, imageDigests: { value: Object.fromEntries(SERVICES.map((service) => [service,digest])) }, appConfiguration: { value: appConfiguration } } };
}

function expectCode(fn, code) { assert.throws(fn, new RegExp(`H5_ACA_VALIDATION_${code}`)); }
function validate(document, options = {}) { return validateH5AcaParameters(document, { authorizedSha:sha, environmentDefaultDomain:'env.example', ...options }); }

test('valida cinco configuraciones efectivas, SHA explícito, digests y referencias secretas', () => {
  const result = validate(validParameters());
  assert.equal(result.sourceSha, sha);
  assert.deepEqual(result.services, SERVICES);
});
test('rechaza SHA mal formado o diferente al SHA de esta ejecución', () => {
  expectCode(() => validate(validParameters(), { authorizedSha: 'bad' }), 'SOURCE_SHA_NOT_AUTHORIZED');
  const doc = validParameters(); doc.parameters.sourceSha.value = 'x'.repeat(40);
  expectCode(() => validate(doc), 'SOURCE_SHA_FORMAT');
});
test('rechaza servicio ausente, digest inválido, variable duplicada o reservada y secreto edge-config', () => {
  const missing = validParameters(); delete missing.parameters.appConfiguration.value['pricing-svc'];
  expectCode(() => validate(missing), 'SERVICE_SET_CONFIGURATION');
  const badDigest = validParameters(); badDigest.parameters.imageDigests.value['catalog-svc'] = 'latest';
  expectCode(() => validate(badDigest), 'IMAGE_DIGEST_INVALID_CATALOG_SVC');
  const reserved = validParameters(); reserved.parameters.appConfiguration.value['api-gateway'].env.push({ name:'API_GATEWAY_PORT', value:'3000' });
  expectCode(() => validate(reserved), 'ENVIRONMENT_RESERVED_API_GATEWAY');
  const edge = validParameters(); edge.parameters.appConfiguration.value['api-gateway'].secrets.push({ name:'edge-config', value:'hidden' });
  expectCode(() => validate(edge), 'SECRET_EDGE_CONFIG_RESERVED');
});
test('rechaza configuración que no permite arrancar, TLS inválido u origen público', () => {
  const missing = validParameters(); missing.parameters.appConfiguration.value['catalog-svc'].env = [{ name:'PGPORT', value:'5432' }];
  expectCode(() => validate(missing), 'EFFECTIVE_CONFIGURATION_MISSING_CATALOG_SVC_PGHOST');
  const tls = validParameters(); tls.parameters.appConfiguration.value['pricing-svc'].secrets[0].value = 'postgresql://u:p@db/g6?sslmode=disable';
  expectCode(() => validate(tls), 'DATABASE_TLS_REQUIRED_PRICING_SVC');
  const origin = validParameters(); origin.parameters.appConfiguration.value['api-gateway'].env[2].value = 'https://public.example';
  expectCode(() => validate(origin), 'PRIVATE_ORIGIN_INVALID_GATEWAY_CATALOG_SVC_URL');
});
test('verifica repositorio, workflow ci.yml, push/master exitoso y metadatos OCI por servicio/SHA', () => {
  const run = {head_sha:sha,event:'push',head_branch:'master',path:OFFICIAL_CI_WORKFLOW,status:'completed',conclusion:'success'};
  assert.equal(verifyGitHubSourceEvidence({ repositoryFullName:OFFICIAL_REPOSITORY, selectedSha: sha, masterSha: sha, workflowRun:run }), true);
  for (const change of [{path:'other.yml'}, {event:'pull_request'}, {head_branch:'feature'}, {conclusion:'failure'}]) {
    assert.throws(() => verifyGitHubSourceEvidence({ repositoryFullName:OFFICIAL_REPOSITORY, selectedSha:sha, masterSha:sha, workflowRun:{...run,...change} }), /SOURCE_CI_PUSH_NOT_SUCCESSFUL/);
  }
  assert.throws(() => verifyGitHubSourceEvidence({ repositoryFullName:'AXL031/G6-Productos-Ofertas-backend', selectedSha:sha, masterSha:sha, workflowRun:run }), /SOURCE_REPOSITORY_NOT_OFFICIAL/);
  assert.equal(verifyOciImageEvidence({ service:'catalog-svc', digest, sourceSha:sha, manifest:{digest,labels:{'org.opencontainers.image.revision':sha,'org.opencontainers.image.source':'https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend','org.opencontainers.image.title':'catalog-svc'}} }), true);
  assert.throws(() => verifyOciImageEvidence({ service:'catalog-svc', digest, sourceSha:sha, manifest:{digest,labels:{}} }), /OCI_SOURCE_MISMATCH/);
});
test('verifica master, CI push exacta y GHCR privado con respuestas simuladas inyectadas', async () => {
  const doc = validParameters();
  const fakeFetch = async (url) => {
    if (url.endsWith('/commits/master')) return Response.json({ sha });
    if (url.includes('/actions/runs?')) return Response.json({ workflow_runs:[{head_sha:sha,event:'push',status:'completed',conclusion:'success',head_branch:'master',path:OFFICIAL_CI_WORKFLOW}] });
    if (url.startsWith('https://ghcr.io/token?')) return Response.json({ token:'simulated-private-token' });
    if (url.includes('/manifests/')) return new Response(JSON.stringify({config:{digest:'sha256:config'}}), {headers:{'docker-content-digest':digest}});
    if (url.includes('/blobs/')) {
      const service = new URL(url).pathname.split('/')[4];
      return Response.json({config:{Labels:{'org.opencontainers.image.revision':sha,'org.opencontainers.image.source':'https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend','org.opencontainers.image.title':service}}});
    }
    return new Response('', {status:404});
  };
  assert.equal(await verifyRemoteEvidence(doc, sha, fakeFetch, {GHCR_READ_USERNAME:'fixture',GHCR_READ_TOKEN:'never-log'}), true);
  await assert.rejects(() => verifyRemoteEvidence(doc, sha, fakeFetch, {}), /GHCR_READ_CREDENTIALS_REQUIRED/);
});
