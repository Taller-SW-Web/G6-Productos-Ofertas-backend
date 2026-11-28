import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

export function evaluateTrivy({ directory, sha, services }) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('SHA candidato inválido');
  const rows = readFileSync(join(directory, 'images.tsv'), 'utf8').trim().split(/\r?\n/).slice(1);
  const images = new Map(rows.map((row) => { const [source, service, imageId] = row.split('\t'); return [service, { source, imageId }]; }));
  const summary = [];
  for (const service of services) {
    const image = images.get(service);
    if (!image || image.source !== sha || !/^sha256:[0-9a-f]{64}$/.test(image.imageId)) throw new Error(`Imagen sin procedencia verificable: ${service}`);
    const report = JSON.parse(readFileSync(join(directory, `${service}.json`), 'utf8'));
    if (report.SchemaVersion !== 2 || report.ArtifactType !== 'container_image' || report.ArtifactName !== `g6-service:${service}-ci` || !Array.isArray(report.Results)) throw new Error(`Reporte Trivy inválido: ${service}`);
    const findings = report.Results.flatMap((result) => result.Vulnerabilities ?? []).filter((finding) => ['HIGH', 'CRITICAL'].includes(finding.Severity));
    summary.push({ service, imageId: image.imageId, highCritical: findings.length });
  }
  if (summary.length !== 9) throw new Error(`Se esperaban nueve imágenes, recibidas ${summary.length}`);
  if (summary.some((entry) => entry.highCritical > 0)) throw new Error(`Trivy detectó hallazgos High/Critical: ${summary.filter((entry) => entry.highCritical).map((entry) => `${entry.service}=${entry.highCritical}`).join(', ')}`);
  return summary;
}

if (process.argv[1]?.endsWith('verify-trivy-report.mjs')) {
  try {
    const [directory, sha, serviceFile] = process.argv.slice(2);
    if (!directory || !serviceFile) throw new Error('Uso: verify-trivy-report.mjs DIRECTORIO SHA SERVICES_PSV');
    const services = readFileSync(serviceFile, 'utf8').split(/\r?\n/).filter((line) => line && !line.startsWith('#')).map((line) => line.split('|')[0]);
    const summary = evaluateTrivy({ directory, sha, services });
    const markdown = `### Trivy High/Critical — ${sha}\n\n| Servicio | Imagen SHA-256 | Hallazgos |\n|---|---|---:|\n${summary.map(({ service, imageId, highCritical }) => `| ${service} | ${imageId} | ${highCritical} |`).join('\n')}\n`;
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
    console.log(markdown);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
