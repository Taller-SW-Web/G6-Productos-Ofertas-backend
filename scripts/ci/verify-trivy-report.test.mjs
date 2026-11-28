import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateTrivy } from './verify-trivy-report.mjs';

test('Trivy falla ante un High sintético, reporte ausente o SHA distinto', () => {
  const directory = mkdtempSync(join(tmpdir(), 'g6-trivy-'));
  const sha = 'a'.repeat(40);
  const services = ['api-gateway','catalog-svc','taxonomy-svc','inventory-svc','combos-svc','promotions-svc','pricing-svc','price-audit-svc','bulk-svc'];
  try {
    writeFileSync(join(directory, 'images.tsv'), `source_sha\tservice\timage_id\n${services.map((service) => `${sha}\t${service}\tsha256:${'b'.repeat(64)}`).join('\n')}\n`);
    const report = (service, vulnerabilities = []) => ({ SchemaVersion: 2, ArtifactType: 'container_image', ArtifactName: `g6-service:${service}-ci`, Results: [{ Vulnerabilities: vulnerabilities }] });
    for (const service of services) writeFileSync(join(directory, `${service}.json`), JSON.stringify(report(service)));
    assert.equal(evaluateTrivy({ directory, sha, services }).length, 9);
    writeFileSync(join(directory, 'bulk-svc.json'), JSON.stringify(report('bulk-svc', [{ VulnerabilityID: 'CVE-2099-0001', Severity: 'HIGH' }])));
    assert.throws(() => evaluateTrivy({ directory, sha, services }), /High\/Critical/);
    assert.throws(() => evaluateTrivy({ directory, sha: 'c'.repeat(40), services }), /procedencia/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
