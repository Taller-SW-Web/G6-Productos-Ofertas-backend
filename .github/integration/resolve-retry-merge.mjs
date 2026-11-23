import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '');
if (!process.argv[2] || root === process.cwd()) {
  throw new Error('An isolated integration worktree path is required.');
}

function resolveConflict(path, expected, replacement) {
  const absolute = resolve(root, path);
  const source = readFileSync(absolute, 'utf8');
  const count = source.split(expected).length - 1;
  if (count !== 1) {
    throw new Error(
      `Unexpected merge conflict block in ${path} (count=${count}).`,
    );
  }
  writeFileSync(absolute, source.replace(expected, replacement), 'utf8');
}

resolveConflict(
  'apps/bulk-svc/src/persistence/bulk.repository.ts',
  `<<<<<<< HEAD\n  contentDocuments,\n=======\n  domainAttempts,\n>>>>>>> origin/pr252`,
  `  contentDocuments,\n  domainAttempts,`,
);

resolveConflict(
  'apps/bulk-svc/src/bulk-svc.http.spec.ts',
  `<<<<<<< HEAD\n        { provide: BulkImportService, useValue: {} },\n        { provide: BulkStorageService, useValue: {} },\n        { provide: BulkContentService, useValue: { download: vi.fn() } },\n=======\n        { provide: BulkImportService, useValue: imports },\n        {\n          provide: BulkStorageService,\n          useValue: {\n            put: vi.fn().mockResolvedValue('private://imports/file.csv'),\n          },\n        },\n>>>>>>> origin/pr252`,
  `        { provide: BulkImportService, useValue: imports },\n        {\n          provide: BulkStorageService,\n          useValue: {\n            put: vi.fn().mockResolvedValue('private://imports/file.csv'),\n          },\n        },\n        { provide: BulkContentService, useValue: { download: vi.fn() } },`,
);

execFileSync(
  'git',
  [
    '-C',
    root,
    'add',
    '--',
    'apps/bulk-svc/src/persistence/bulk.repository.ts',
    'apps/bulk-svc/src/bulk-svc.http.spec.ts',
  ],
  { stdio: 'inherit' },
);
const unresolved = execFileSync(
  'git',
  ['-C', root, 'diff', '--name-only', '--diff-filter=U'],
  { encoding: 'utf8' },
).trim();
if (unresolved) throw new Error(`Unresolved conflicts remain:\n${unresolved}`);
