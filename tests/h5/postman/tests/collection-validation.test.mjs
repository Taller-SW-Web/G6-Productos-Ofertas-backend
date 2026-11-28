import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COLLECTION_PATH,
  OPENAPI_CONTRACT_PATH,
  POSTMAN_ROOT,
  SCHEMAS_PATH,
} from '../scripts/lib/constants.mjs';
import {
  createOpenApiValidator,
  verifySchemaContractAlignment,
} from '../scripts/lib/openapi-schema-validator.mjs';
import {
  DEFAULT_COVERAGE_CSV_PATH,
  scanFilesForSecrets,
  validateCollectionAgainstOpenApi,
  validateCollectionStructure,
  validateMatrixParity,
} from '../scripts/lib/preflight-core.mjs';

test('La coleccion Postman es JSON valido v2.1.0, solo lectura, 38 casos y followRedirects=false', () => {
  const result = validateCollectionStructure(COLLECTION_PATH);
  assert.equal(result.ok, true, `Errores de validacion: ${result.errors.join(' | ')}`);
  assert.equal(result.requests.length, 38);
  for (const req of result.requests) {
    assert.equal(
      req.protocolProfileBehavior?.followRedirects,
      false,
      `Falta followRedirects=false en ${req.name}`,
    );
  }
});

test('H10 + H13: Rutas /api/v1 coinciden con OpenAPI 0.7.0-rc.3 y esquemas locales no divergen del contrato oficial', () => {
  const openApi = validateCollectionAgainstOpenApi(COLLECTION_PATH, OPENAPI_CONTRACT_PATH);
  assert.equal(openApi.ok, true, `Errores OpenAPI: ${openApi.errors.join(' | ')}`);
  assert.equal(openApi.openApiOperationCount, 156);

  const align = verifySchemaContractAlignment(OPENAPI_CONTRACT_PATH, SCHEMAS_PATH);
  assert.equal(align.ok, true, `Divergencia de esquemas: ${align.errors.join(' | ')}`);
  assert.equal(align.officialVersion, '0.7.0-rc.3');

  const parity = validateMatrixParity(COLLECTION_PATH, DEFAULT_COVERAGE_CSV_PATH);
  assert.equal(parity.ok, true, `Errores de paridad CSV: ${parity.errors.join(' | ')}`);
});

test('H13 Regresion: Ajv compilado desde OpenAPI oficial valida formatos, objetos anidados y detecta deriva de contrato', () => {
  const validator = createOpenApiValidator(OPENAPI_CONTRACT_PATH);
  assert.equal(validator.version, '0.7.0-rc.3');

  const validPrecio = validator.validate('Precio', {
    sku: 'SKU-H5-001',
    precio_regular: 55,
    precio_oferta: 45,
    currency: 'PEN',
    channel_id: 'MARKETPLACE',
    valid_from: '2026-11-01T00:00:00.000Z',
    valid_until: null,
    price_version: 1,
    vigencia_id: '00000000-0000-4000-8000-000000000101',
    origen: 'PRODUCTO',
  });
  assert.equal(validPrecio.ok, true, `Precio valido fallo Ajv: ${validPrecio.errors.join('; ')}`);

  // Formato date-time invalido debe fallar
  const badFormat = validator.validate('Precio', {
    sku: 'SKU-H5-001',
    precio_regular: 55,
    precio_oferta: 45,
    currency: 'PEN',
    channel_id: 'MARKETPLACE',
    valid_from: 'no-es-fecha-iso',
    valid_until: null,
    price_version: 1,
    vigencia_id: '00000000-0000-4000-8000-000000000101',
    origen: 'PRODUCTO',
  });
  assert.equal(badFormat.ok, false, 'Ajv debe rechazar valid_from invalido');

  // Propiedad extra en DisponibilidadComercial (additionalProperties: false) debe fallar
  const extraProp = validator.validate('DisponibilidadComercial', {
    sku: 'SKU-H5-001',
    status: 'DISPONIBLE',
    on_hand: 99,
  });
  assert.equal(extraProp.ok, false, 'Ajv debe rechazar propiedad adicional en DisponibilidadComercial');

  // H17: Deteccion profunda de deriva (campo requerido, tipo, enum y formato)
  const tmp = mkdtempSync(join(tmpdir(), 'g6-h17-drift-'));
  try {
    const drifted = JSON.parse(readFileSync(SCHEMAS_PATH, 'utf8'));
    drifted.$defs.Precio.required = drifted.$defs.Precio.required.filter((f) => f !== 'currency');
    drifted.$defs.Precio.properties.precio_regular.type = 'string';
    drifted.$defs.Precio.properties.valid_from.format = 'uri';
    drifted.$defs.Precio.properties.origen.enum = ['PRODUCTO'];
    const driftPath = join(tmp, 'drifted-schemas.json');
    writeFileSync(driftPath, JSON.stringify(drifted), 'utf8');
    const driftCheck = verifySchemaContractAlignment(OPENAPI_CONTRACT_PATH, driftPath);
    assert.equal(driftCheck.ok, false, 'Debe detectar deriva profunda de contrato');
    assert.ok(driftCheck.errors.some((e) => e.includes('currency')), 'Debe detectar campo requerido faltante');
    assert.ok(driftCheck.errors.some((e) => e.includes('precio_regular')), 'Debe detectar divergencia de tipo');
    assert.ok(driftCheck.errors.some((e) => e.includes('valid_from')), 'Debe detectar divergencia de formato');
    assert.ok(driftCheck.errors.some((e) => e.includes('origen')), 'Debe detectar divergencia de enum');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('H09 + H15: La coleccion valida URL final, redirecciones y encapsula todo pm.sendRequest en safeSendRequest', () => {
  const raw = JSON.parse(readFileSync(COLLECTION_PATH, 'utf8'));
  assert.equal(raw.info.name, 'G6 - H5 Integration Suite');

  const pre = (raw.event || []).find((e) => e.listen === 'prerequest');
  assert.ok(pre);
  const preCode = pre.script.exec.join('\n');
  assert.ok(preCode.includes('pm.variables.replaceIn(pm.request.url.toString())'));
  assert.ok(preCode.includes('apim-g6-productos-chile.azure-api.net'));

  const globalTest = (raw.event || []).find((e) => e.listen === 'test');
  assert.ok(globalTest);
  assert.ok(globalTest.script.exec.join('\n').includes('Location'));

  // H15: Ningun script debe invocar pm.sendRequest sin pasar por safeSendRequest (followRedirects: false + allowlist)
  const serialized = JSON.stringify(raw);
  const directMatches = serialized.match(/pm\.sendRequest\(/g) || [];
  const safeDefs = serialized.match(/function safeSendRequest\(/g) || [];
  assert.equal(
    directMatches.length,
    safeDefs.length,
    'Toda llamada a pm.sendRequest debe estar encapsulada exclusivamente dentro de safeSendRequest()',
  );
  assert.ok(serialized.includes('followRedirects: false'));
});

test('No existen secretos reales en archivos versionados del directorio postman', () => {
  assert.equal(existsSync(SCHEMAS_PATH), true);
  const findings = scanFilesForSecrets(POSTMAN_ROOT);
  assert.deepEqual(findings, [], `Se detectaron posibles secretos: ${JSON.stringify(findings)}`);
});
