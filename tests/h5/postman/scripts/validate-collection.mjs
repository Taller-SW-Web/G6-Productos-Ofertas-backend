#!/usr/bin/env node
import { COLLECTION_PATH, OPENAPI_CONTRACT_PATH, POSTMAN_ROOT, SCHEMAS_PATH } from './lib/constants.mjs';
import { verifySchemaContractAlignment } from './lib/openapi-schema-validator.mjs';
import {
  DEFAULT_COVERAGE_CSV_PATH,
  scanFilesForSecrets,
  validateCollectionAgainstOpenApi,
  validateCollectionStructure,
  validateMatrixParity,
} from './lib/preflight-core.mjs';

const struct = validateCollectionStructure(COLLECTION_PATH);
const openApi = validateCollectionAgainstOpenApi(COLLECTION_PATH, OPENAPI_CONTRACT_PATH);
const schemaAlign = verifySchemaContractAlignment(OPENAPI_CONTRACT_PATH, SCHEMAS_PATH);
const parity = validateMatrixParity(COLLECTION_PATH, DEFAULT_COVERAGE_CSV_PATH);
const secrets = scanFilesForSecrets(POSTMAN_ROOT);

if (!struct.ok) {
  console.error('[VALIDATE] Errores de estructura en la coleccion:');
  for (const err of struct.errors) console.error(`  - ${err}`);
}

if (!openApi.ok) {
  console.error('[VALIDATE] Errores de paridad con OpenAPI oficial:');
  for (const err of openApi.errors) console.error(`  - ${err}`);
}

if (!schemaAlign.ok) {
  console.error('[VALIDATE] H13 — Divergencia entre schemas locales y OpenAPI oficial:');
  for (const err of schemaAlign.errors) console.error(`  - ${err}`);
}

if (!parity.ok) {
  console.error('[VALIDATE] Errores de conciliacion entre coleccion, CASE_METADATA y matriz CSV:');
  for (const err of parity.errors) console.error(`  - ${err}`);
}

if (secrets.length > 0) {
  console.error('[VALIDATE] Posibles secretos detectados en archivos versionados:');
  for (const finding of secrets) console.error(`  - ${finding.file} (patron: ${finding.pattern})`);
}

if (!struct.ok || !openApi.ok || !schemaAlign.ok || !parity.ok || secrets.length > 0) {
  process.exit(1);
}

const csvNote = parity.csvSkipped
  ? 'CSV Docs opcional no presente en este checkout'
  : `matriz CSV ${parity.csvCount} casos`;

console.log(
  `[VALIDATE] OK — Coleccion valida (${struct.requests.length} solicitudes, OpenAPI ${schemaAlign.officialVersion} / ${openApi.openApiOperationCount} ops, schemas Ajv alineados, ${csvNote}, 0 secretos detectados).`,
);
