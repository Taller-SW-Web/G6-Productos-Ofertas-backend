#!/usr/bin/env node
import { existsSync } from 'node:fs';
import {
  COLLECTION_PATH,
  DOCS_ROOT,
  FAST_DEV_OPENAPI_PATH,
  OFFICIAL_OPENAPI_CONTRACT_PATH,
  POSTMAN_ROOT,
  SCHEMAS_PATH,
} from './lib/constants.mjs';
import { verifySchemaContractAlignment } from './lib/openapi-schema-validator.mjs';
import {
  DEFAULT_COVERAGE_CSV_PATH,
  scanFilesForSecrets,
  validateCollectionAgainstOpenApi,
  validateCollectionStructure,
  validateMatrixParity,
} from './lib/preflight-core.mjs';
import { resolveGitHead } from './lib/report-core.mjs';

const fastDev = process.argv.includes('--fast-dev');
const openApiPath = fastDev ? FAST_DEV_OPENAPI_PATH : OFFICIAL_OPENAPI_CONTRACT_PATH;
const contractMode = fastDev ? 'FAST_DEV_NON_AUTHORITATIVE' : 'STRICT_OFFICIAL';

if (!fastDev && !existsSync(OFFICIAL_OPENAPI_CONTRACT_PATH)) {
  console.error(
    `[VALIDATE] H22 ERROR (modo estricto): No se encontro el OpenAPI oficial en '${OFFICIAL_OPENAPI_CONTRACT_PATH}'.`,
  );
  console.error(
    '  Defina G6_DOCS_ROOT apuntando al checkout de G6-Productos-Ofertas-docs (o use --fast-dev solo para desarrollo rapido no acreditable).',
  );
  process.exit(1);
}

if (!fastDev && !existsSync(DEFAULT_COVERAGE_CSV_PATH)) {
  console.error(
    `[VALIDATE] H22 ERROR (modo estricto): No se encontro la matriz CSV oficial en '${DEFAULT_COVERAGE_CSV_PATH}'.`,
  );
  process.exit(1);
}

const struct = validateCollectionStructure(COLLECTION_PATH);
const openApi = validateCollectionAgainstOpenApi(COLLECTION_PATH, openApiPath);
const schemaAlign = verifySchemaContractAlignment(openApiPath, SCHEMAS_PATH);
const parity = validateMatrixParity(COLLECTION_PATH, DEFAULT_COVERAGE_CSV_PATH);
const secrets = scanFilesForSecrets(POSTMAN_ROOT);
const docsSha = resolveGitHead(DOCS_ROOT);

if (!struct.ok) {
  console.error('[VALIDATE] Errores de estructura en la coleccion:');
  for (const err of struct.errors) console.error(`  - ${err}`);
}

if (!openApi.ok) {
  console.error('[VALIDATE] Errores de paridad con OpenAPI:');
  for (const err of openApi.errors) console.error(`  - ${err}`);
}

if (!schemaAlign.ok) {
  console.error('[VALIDATE] H17 — Divergencia estructural entre schemas locales y OpenAPI:');
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
  ? 'CSV omitido (--fast-dev)'
  : `matriz CSV ${parity.csvCount} casos`;

console.log(
  `[VALIDATE] OK [${contractMode}] — Coleccion valida (${struct.requests.length} solicitudes, OpenAPI ${schemaAlign.officialVersion} / ${openApi.openApiOperationCount} ops, SHA-256=${schemaAlign.officialSha256.slice(0, 12)}..., DocsSHA=${docsSha.slice(0, 12)}, schemas Ajv alineados, ${csvNote}, 0 secretos).`,
);
