import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '');
if (!process.argv[2] || root === process.cwd()) {
  throw new Error('An isolated integration worktree path is required.');
}

function replaceOnce(source, expected, replacement, label) {
  const count = source.split(expected).length - 1;
  if (count !== 1) {
    throw new Error(
      `Unexpected combined-test anchor ${label} (count=${count}).`,
    );
  }
  return source.replace(expected, replacement);
}

const path = resolve(
  root,
  'apps/bulk-svc/src/persistence/bulk.repository.integration.spec.ts',
);
let source = readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
source = replaceOnce(
  source,
  "import { BulkSvcController } from '../bulk-svc.controller.js';\n",
  "import { BulkSvcController } from '../bulk-svc.controller.js';\nimport { BulkContentService } from '../bulk-content.service.js';\n",
  'BulkContentService import',
);
source = replaceOnce(
  source,
  '  bulkSchema,\n  batchJobs,\n  batchRows,',
  '  bulkSchema,\n  batchJobs,\n  contentDocuments,\n  batchRows,',
  'content document schema import',
);
source = replaceOnce(
  source,
  "AND table_name IN ('file_manifests','batch_jobs','batch_rows','row_domain_steps','export_jobs','outbox','inbox')",
  "AND table_name IN ('content_documents','file_manifests','batch_jobs','batch_rows','row_domain_steps','export_jobs','outbox','inbox')",
  'content document DDL audit',
);
source = replaceOnce(
  source,
  '    const tables = [\n      fileManifests,\n      batchJobs,\n      batchRows,',
  '    const tables = [\n      fileManifests,\n      batchJobs,\n      contentDocuments,\n      batchRows,',
  'content document column model',
);
const sectionStart = source.indexOf(
  "it('calculates Catalog V3 eligibility from normalized admitted rows and a real attempt receipt'",
);
const sectionEnd = source.indexOf('\n  it(', sectionStart + 1);
if (sectionStart < 0 || sectionEnd < 0) {
  throw new Error('Catalog eligibility integration test section not found.');
}
let section = source.slice(sectionStart, sectionEnd);
section = replaceOnce(
  section,
  '    const operationId = randomUUID();\n',
  '    const operationId = randomUUID();\n    const contentId = randomUUID();\n',
  'claim-check content identity',
);
section = replaceOnce(
  section,
  '          content_id: randomUUID(),',
  '          content_id: contentId,',
  'V3 command content identity',
);
section = replaceOnce(
  section,
  "        inputFile: { format: 'CSV', contentRef },\n",
  "        inputFile: { format: 'CSV', contentRef },\n        contentDocument: {\n          contentId,\n          batchId,\n          batchOperationId: operationId,\n          contentRef,\n          sha256: 'a'.repeat(64),\n          byteLength: 128,\n          contentType: 'application/json',\n        },\n",
  'durable claim-check document admission',
);
section = replaceOnce(
  section,
  '        .where(eq(outbox.schemaVersion, 4));',
  '        .where(and(eq(outbox.schemaVersion, 4), eq(outbox.operationId, operationId)));',
  'retry outbox scoped to operation',
);
source = source.slice(0, sectionStart) + section + source.slice(sectionEnd);
source = replaceOnce(
  source,
  '        { provide: BulkStorageService, useValue: {} },\n',
  '        { provide: BulkStorageService, useValue: {} },\n        { provide: BulkContentService, useValue: { download: vi.fn() } },\n',
  'BulkContentService provider',
);
source = replaceOnce(
  source,
  '      .useValue({ canActivate: () => true })',
  `      .useValue({\n        canActivate: (context: {\n          switchToHttp(): { getRequest(): { bulkActorSub?: string } };\n        }) => {\n          context.switchToHttp().getRequest().bulkActorSub = TEST_OWNER_SUB;\n          return true;\n        },\n      })`,
  'outage route actor identity',
);
writeFileSync(path, source, 'utf8');
