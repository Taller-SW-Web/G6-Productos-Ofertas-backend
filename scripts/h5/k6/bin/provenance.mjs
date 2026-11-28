import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const root = 'scripts/h5/k6/';
const oracle = 'apps/catalog-svc/test/performance/h5/catalog-pagination-integrity.mjs';
const cases = {
  'PERF-01': 'catalogo-lectura.k6.js',
  'PERF-02': 'pricing-lectura.k6.js',
  'PERF-03': 'inventario-lectura.k6.js',
};
const common = [
  'bin/preflight.ps1', 'bin/ejecutar-demo.ps1', 'bin/provenance.mjs', 'bin/staging-permit.mjs',
  'config/k6-options.json', 'config/staging-authorities.json', 'scripts/lectura.js', 'scripts/contratos.js',
];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'ignore'] });
const text = (cwd, ...args) => git(cwd, ...args).toString('utf8').trim();
const fullSha = /^[a-f0-9]{40}$/;

export function harnessPaths(caseId) {
  if (!Object.hasOwn(cases, caseId)) throw new Error('EVIDENCIA_CASO_ARNES_INVALIDO');
  return [...common.map((path) => root + path), root + 'scripts/' + cases[caseId], oracle].sort();
}

function treeEvidence(cwd, caseId, commit) {
  if (!fullSha.test(commit) || text(cwd, 'rev-parse', '--verify', commit + '^{commit}') !== commit) {
    throw new Error('EVIDENCIA_SHA_ARNES_INVALIDO');
  }
  const tree = text(cwd, 'rev-parse', commit + '^{tree}');
  const hashes = Object.fromEntries(harnessPaths(caseId).map((path) => [path, sha256(git(cwd, 'cat-file', 'blob', commit + ':' + path))]));
  return { harness_commit: commit, harness_tree: tree, harness_files_sha256: hashes };
}

export function snapshot(caseId, cwd = repo) {
  const commit = text(cwd, 'rev-parse', '--verify', 'HEAD');
  const state = text(cwd, 'status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none');
  const flags = text(cwd, 'ls-files', '-v').split('\n');
  const modified = harnessPaths(caseId).some((path) => {
    // Usa los filtros de Git para dar el mismo hash con LF y CRLF, pero compara
    // el archivo real incluso si el índice oculta cambios con assume-unchanged.
    try {
      return !lstatSync(resolve(cwd, path)).isFile() ||
        text(cwd, 'hash-object', '--path=' + path, '--', path) !== text(cwd, 'rev-parse', commit + ':' + path);
    } catch {
      return true;
    }
  });
  const dirty = modified || !!state || flags.some((line) => /^(?:[a-z]|S) /.test(line));
  return { ...treeEvidence(cwd, caseId, commit), harness_dirty: dirty };
}

export function verifyReportProvenance(report, cwd = repo) {
  if (report?.harness_dirty !== false) throw new Error('EVIDENCIA_ARNES_SUCIO');
  const expected = treeEvidence(cwd, report.case_id, report.harness_commit);
  const recorded = report.harness_files_sha256;
  if (!recorded || report.harness_tree !== expected.harness_tree ||
      Object.keys(recorded).length !== Object.keys(expected.harness_files_sha256).length ||
      Object.entries(expected.harness_files_sha256).some(([path, hash]) => recorded[path] !== hash)) {
    throw new Error('EVIDENCIA_HASH_ARNES_NO_CORRESPONDE');
  }
  return expected;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [, , action, argument] = process.argv;
    if (action === 'snapshot' || action === 'require-clean') {
      const evidence = snapshot(argument);
      if (action === 'require-clean' && evidence.harness_dirty) throw new Error('EVIDENCIA_ARNES_SUCIO');
      process.stdout.write(JSON.stringify(evidence));
    } else if (action === 'verify') {
      const report = JSON.parse(readFileSync(argument, 'utf8').replace(/^\uFEFF/, ''));
      process.stdout.write(JSON.stringify(verifyReportProvenance(report)));
    } else throw new Error('EVIDENCIA_MODO_ARNES_INVALIDO');
  } catch (error) {
    process.stdout.write(/^EVIDENCIA_[A-Z0-9_]+$/.test(error.message) ? error.message : 'EVIDENCIA_GIT_NO_VERIFICABLE');
    process.exitCode = 2;
  }
}
