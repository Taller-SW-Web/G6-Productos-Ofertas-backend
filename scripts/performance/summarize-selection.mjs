import { mkdir, writeFile } from 'node:fs/promises';

const component = process.env.COMPONENT;
const jobResults = JSON.parse(process.env.JOB_RESULTS ?? '{}');
const scenarioJobs = {
  catalog: ['catalog_http_performance'],
  pricing: ['pricing_individual_http_performance'],
  combos: ['combos_h5_http_performance'],
  promotions: ['promotions_http_performance', 'promotions_paired_http_performance'],
  'inventory-gateway': ['gateway_inventory_http_performance'],
};

const selected = scenarioJobs[component] ?? [];
const scenarios = Object.fromEntries(
  selected.map((jobId) => [jobId, jobResults[jobId]?.result ?? 'missing']),
);
const complete =
  jobResults.preflight?.result === 'success' &&
  selected.length > 0 &&
  selected.every((jobId) => scenarios[jobId] === 'success');
const result = {
  classification: complete ? 'PASS_SELECTED_SCENARIOS' : 'PARTIAL',
  performanceClassification: 'SIN_UMBRAL_APROBADO',
  integral: false,
  component,
  scenarios,
  baselineSha: jobResults.preflight?.outputs?.baseline_sha ?? null,
  candidateSha: jobResults.preflight?.outputs?.candidate_sha ?? null,
  limitation: 'Comparación HTTP local sobre runner compartido; no demuestra latencia de producción ni Azure Service Bus real.',
  runId: process.env.GITHUB_RUN_ID ?? null,
};

await mkdir('.ci/performance/summary', { recursive: true });
await writeFile(
  '.ci/performance/summary/selection-summary.json',
  `${JSON.stringify(result, null, 2)}\n`,
);
console.log(JSON.stringify(result, null, 2));
if (!complete) process.exitCode = 1;
