import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const APPROVED_SOURCE_SHA =
  'fcf3dd983f5436221670e8c6a113fdd15cb76de9';

export const SERVICES = Object.freeze([
  'api-gateway',
  'catalog-svc',
  'inventory-svc',
  'pricing-svc',
  'promotions-svc',
]);

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

export function validateH5AcaParameters(document) {
  if (!isRecord(document) || !isRecord(document.parameters))
    fail('PARAMETER_FILE_INVALID');

  const parameters = document.parameters;
  const sourceSha = parameterValue(parameters, 'sourceSha');
  if (typeof sourceSha !== 'string' || !/^[a-fA-F0-9]{40}$/.test(sourceSha))
    fail('SOURCE_SHA_FORMAT');
  if (sourceSha.toLowerCase() !== APPROVED_SOURCE_SHA)
    fail('SOURCE_SHA_NOT_AUTHORIZED');

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
  }

  return Object.freeze({ sourceSha, services: SERVICES });
}

function main() {
  const [, , parameterFile] = process.argv;
  if (!parameterFile) fail('USAGE');
  const result = validateH5AcaParameters(
    JSON.parse(readFileSync(parameterFile, 'utf8')),
  );
  process.stdout.write(
    `H5 ACA parameters valid: ${result.services.length} services, SHA ${result.sourceSha}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'H5_ACA_VALIDATION_FAILED'}\n`,
    );
    process.exitCode = 1;
  }
}
