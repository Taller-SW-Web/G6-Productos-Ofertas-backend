import assert from 'node:assert/strict';
import test from 'node:test';
import {
  APPROVED_SOURCE_SHA,
  SERVICES,
  validateH5AcaParameters,
} from './validate-h5-five-apps.mjs';

const digest = `sha256:${'a'.repeat(64)}`;

function validParameters() {
  const appConfiguration = Object.fromEntries(
    SERVICES.map((service) => [
      service,
      {
        env: [
          { name: 'PGHOST', value: 'db.internal' },
          { name: 'PGPASSWORD', secretRef: 'runtime-password' },
        ],
        secrets: [{ name: 'runtime-password', value: 'never-print-this-value' }],
      },
    ]),
  );
  return {
    parameters: {
      sourceSha: { value: APPROVED_SOURCE_SHA },
      imageDigests: {
        value: Object.fromEntries(SERVICES.map((service) => [service, digest])),
      },
      appConfiguration: { value: appConfiguration },
    },
  };
}

function expectCode(document, code) {
  assert.throws(
    () => validateH5AcaParameters(document),
    (error) =>
      error instanceof Error &&
      error.message === `H5_ACA_VALIDATION_${code}` &&
      !error.message.includes('never-print-this-value') &&
      !error.message.includes('sensitive-second-value'),
  );
}

test('acepta exactamente cinco apps, SHA autorizado, digests y configuración segura', () => {
  const result = validateH5AcaParameters(validParameters());
  assert.equal(result.sourceSha, APPROVED_SOURCE_SHA);
  assert.deepEqual(result.services, SERVICES);
});

test('rechaza SHA mal formado y SHA distinto del autorizado', () => {
  const badFormat = validParameters();
  badFormat.parameters.sourceSha.value = 'abc';
  expectCode(badFormat, 'SOURCE_SHA_FORMAT');

  const wrongSha = validParameters();
  wrongSha.parameters.sourceSha.value = '0'.repeat(40);
  expectCode(wrongSha, 'SOURCE_SHA_NOT_AUTHORIZED');
});

test('rechaza servicios omitidos o adicionales', () => {
  const missing = validParameters();
  delete missing.parameters.imageDigests.value['pricing-svc'];
  expectCode(missing, 'SERVICE_SET_IMAGE_DIGESTS');

  const extra = validParameters();
  extra.parameters.appConfiguration.value['taxonomy-svc'] = {
    env: [],
    secrets: [],
  };
  expectCode(extra, 'SERVICE_SET_CONFIGURATION');
});

test('rechaza digests OCI inválidos', () => {
  const parameters = validParameters();
  parameters.parameters.imageDigests.value['catalog-svc'] = 'latest';
  expectCode(parameters, 'IMAGE_DIGEST_INVALID_CATALOG_SVC');
});

test('rechaza configuración incompleta', () => {
  const parameters = validParameters();
  delete parameters.parameters.appConfiguration.value['promotions-svc'].secrets;
  expectCode(parameters, 'CONFIGURATION_INCOMPLETE_PROMOTIONS_SVC');

  const emptyEnvironment = validParameters();
  emptyEnvironment.parameters.appConfiguration.value['catalog-svc'].env = [];
  expectCode(emptyEnvironment, 'CONFIGURATION_INCOMPLETE_CATALOG_SVC');
});

test('rechaza nombres duplicados y reservados sin imprimir secretos', () => {
  const duplicateEnv = validParameters();
  duplicateEnv.parameters.appConfiguration.value['catalog-svc'].env.push({
    name: 'pghost',
    value: 'other.internal',
  });
  expectCode(duplicateEnv, 'ENVIRONMENT_NAME_DUPLICATE_CATALOG_SVC');

  const guarded = validParameters();
  guarded.parameters.appConfiguration.value['api-gateway'].env.push({
    name: 'GATEWAY_G5_H5_ENABLED',
    value: 'true',
  });
  expectCode(guarded, 'ENVIRONMENT_RESERVED_API_GATEWAY');

  const duplicateSecrets = validParameters();
  duplicateSecrets.parameters.appConfiguration.value['inventory-svc'].secrets.push({
    name: 'runtime-password',
    value: 'sensitive-second-value',
  });
  expectCode(duplicateSecrets, 'SECRET_NAME_DUPLICATE_INVENTORY_SVC');
});

test('protege edge-config y exige referencias secretRef declaradas', () => {
  const collision = validParameters();
  collision.parameters.appConfiguration.value['api-gateway'].secrets.push({
    name: 'edge-config',
    value: 'do-not-log',
  });
  expectCode(collision, 'SECRET_EDGE_CONFIG_RESERVED');

  const missingRef = validParameters();
  missingRef.parameters.appConfiguration.value['pricing-svc'].env[1].secretRef =
    'missing-secret';
  expectCode(missingRef, 'SECRET_REFERENCE_INVALID_PRICING_SVC');
});
