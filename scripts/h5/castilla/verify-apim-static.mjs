#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readJson } from './common.mjs';

const args = Object.fromEntries(process.argv.slice(2).filter((x) => x.startsWith('--')).map((x, i, a) => [x.slice(2), a[i + 1]]));
const repo = resolve(args.repo ?? process.cwd());
const docs = resolve(args['docs-root'] ?? process.env.H5_DOCS_ROOT ?? '../docs');
const apim = join(repo, 'ops/azure/apim');
const findings = [];
const note = (code, severity, message, data = {}) => findings.push({ code, severity, message, ...data });
const manifestPath = join(apim, 'openapi/operation-security.json');
if (!existsSync(manifestPath)) throw new Error('APIM operation-security.json is missing');
const manifest = readJson(manifestPath);
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
const docsSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: docs, encoding: 'utf8' }).trim();
if (manifest.docsSha !== docsSha) note('APIM_PROVENANCE_DOCS_DRIFT', 'review', 'Embedded Docs SHA differs from current Docs HEAD', { embedded_sha: manifest.docsSha, current_sha: docsSha });
if (manifest.gatewaySha !== head) note('APIM_PROVENANCE_GATEWAY_DRIFT', 'review', 'Embedded Gateway provenance differs from current Backend HEAD', { embedded_sha: manifest.gatewaySha, current_sha: head });
if (manifest.g5EnabledByDefault !== false) note('G5_DEFAULT_NOT_DISABLED', 'critical', 'G5 must remain disabled by default');
const privateIds = new Set(manifest.privateOperationIds ?? []);
const internalOperations = (manifest.operations ?? []).filter((operation) => privateIds.has(operation.operationId));
if (internalOperations.length) note('INTERNAL_OPERATION_IMPORTED', 'critical', 'Manifest contains operations classified private', { count: internalOperations.length });
if (privateIds.size !== 5) note('INTERNAL_OPERATION_COUNT_CHANGED', 'critical', 'Expected five x-internal operation IDs in current APIM contract filter', { observed: privateIds.size });
const filteredPath = join(apim, 'openapi/gateway-filtered.json');
const filtered = existsSync(filteredPath) ? readJson(filteredPath) : null;
const importedRecords = new Set((manifest.operations ?? []).map((operation) => `${operation.method.toLowerCase()} ${operation.path}`));
const filteredRecords = new Set();
for (const [path, pathItem] of Object.entries(filtered?.paths ?? {})) {
  for (const [method, operation] of Object.entries(pathItem)) {
    if (['get','post','put','patch','delete','options','head'].includes(method.toLowerCase())) filteredRecords.add(`${method.toLowerCase()} ${path}`);
  }
}
const operationDrift = [...new Set([...importedRecords, ...filteredRecords])].filter((key) => importedRecords.has(key) !== filteredRecords.has(key));
if (operationDrift.length) note('APIM_OPERATION_SET_DRIFT', 'critical', 'Filtered OpenAPI and security manifest operation sets differ', { operations: operationDrift });
const g5Imported = (manifest.operations ?? []).filter((operation) => operation.g5OptIn === true);
if (g5Imported.length) note('G5_OPERATION_ENABLED', 'critical', 'G5 operations must remain opt-in and disabled by default', { count: g5Imported.length });
const duplicates = (manifest.operations ?? []).map((x) => x.apimOperationId).filter((id, i, list) => list.indexOf(id) !== i);
if (duplicates.length) note('APIM_OPERATION_ID_COLLISION', 'critical', 'Duplicate APIM operation IDs exist', { identifiers: [...new Set(duplicates)] });
const xml = readFileSync(join(apim, 'policies/api.xml'), 'utf8');
const policy = {
  burst: /<rate-limit-by-key\b/.test(xml),
  quota: /<quota-by-key\b/.test(xml),
  retryAfter: /Retry-After/i.test(xml),
  jwt: /validate-jwt\b/.test(xml),
  keyUsesValidatedIdentity: /rateIdentity/.test(xml),
};
if (!policy.burst || !policy.quota) note('APIM_POLICY_RATE_LIMIT_MISSING', 'critical', 'Burst and quota policies must be inspected independently', { policy });
const bicep = readFileSync(join(apim, 'main.bicep'), 'utf8');
const network = { gateway_backend_parameterized: /param\s+gatewayBackendUrl\s+string/.test(bicep), gateway_backend_https_private_requirement: /Base URL privada aprobada/.test(bicep), apim_api_protocol_https: /protocols\s*:\s*\[\s*'https'\s*\]/s.test(bicep), apim_public_network_access_enabled: /publicNetworkAccess:\s*'Enabled'/.test(bicep), sku_developer_classic: /name:\s*'Developer'/.test(bicep), external_vnet: /virtualNetworkType:\s*'External'/.test(bicep) };
if (!network.apim_api_protocol_https || !network.gateway_backend_parameterized || !network.gateway_backend_https_private_requirement) note('APIM_NETWORK_STATIC_GAP', 'critical', 'HTTPS/private backend declarations do not meet the documented static expectation', { network });
if (network.apim_public_network_access_enabled) note('APIM_PUBLIC_INGRESS_CONFIGURED', 'review', 'Bicep enables public APIM ingress; confirm approved client edge/network model before any real test', { network });
const policyHashes = Object.fromEntries(['api.xml','operation-public.xml','operation-secured.xml'].map((name) => [name, createHash('sha256').update(readFileSync(join(apim, 'policies', name))).digest('hex')]));
const docsApim = join(docs, 'hitos/h5/04_API_MANAGEMENT.md');
const docsReadme = join(docs, 'scripts/h5/evidence/README.md');
const backendReadme = readFileSync(join(apim, 'README.md'), 'utf8');
const apimText = existsSync(docsApim) ? readFileSync(docsApim, 'utf8') : '';
const docIdRows = [...apimText.matchAll(/\|\s*(APIM-T\d{2})\s*\|\s*([^|]+)/g)].map((m) => ({ id: m[1], title: m[2].trim() }));
const readmeIdRows = [...backendReadme.matchAll(/\|\s*(?:APIM-)?(T\d{2})\s*\|\s*([^|]+)/g)].map((m) => ({ id: `APIM-${m[1]}`, title: m[2].trim() }));
const byId = (rows) => Object.fromEntries(rows.map((row) => [row.id, row.title]));
const docIds = byId(docIdRows); const backendIds = byId(readmeIdRows);
const differences = [...new Set([...Object.keys(docIds), ...Object.keys(backendIds)])].filter((id) => docIds[id] !== backendIds[id]).map((id) => ({ id, docs: docIds[id] ?? null, backend_readme: backendIds[id] ?? null }));
if (differences.length) note('APIM_ID_RECONCILIATION_REQUIRED', 'review', 'Docs APIM-T IDs and Backend README IDs differ; keep sources distinct pending owner review', { differences, proposal: 'Add internal harness IDs APIM-CASE-<stable-name>; request Docs/Backend owners to reconcile labels without merging unlike scenarios.' });
if (!existsSync(docsReadme)) note('DOCS_EVIDENCE_MODULE_ABSENT', 'info', 'Docs evidence module is not present in the selected Docs HEAD');
const report = {
  schema: 'h5-apim-static-report/v1',
  generated_at: new Date().toISOString(),
  current_backend_sha: head,
  current_docs_sha: docsSha,
  apim_manifest: { docs_sha: manifest.docsSha, gateway_sha: manifest.gatewaySha, operations: manifest.operations?.length ?? 0, g5_enabled_by_default: manifest.g5EnabledByDefault, private_operation_ids: manifest.privateOperationIds },
  policy_inspection: policy,
  network_static_inspection: network,
  policy_hashes: policyHashes,
  id_reconciliation: { source_docs: 'hitos/h5/04_API_MANAGEMENT.md', source_backend: 'ops/azure/apim/README.md', differences },
  findings,
  states: { implementation_state: 'DONE_LOCAL', execution_result: 'NOT_RUN_REAL_APIM', deployment_state: 'NOT_VERIFIED', homologation_state: 'NOT_VERIFIED' },
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
