import { mkdir, writeFile } from 'node:fs/promises';

const component = process.env.COMPONENT;
const jobResults = JSON.parse(process.env.JOB_RESULTS ?? '{}');
const scenarioJobs = {
  catalog: ['catalog_http_performance'],
  pricing: ['pricing_individual_http_performance'],
};
const unavailableComponents = {
  combos: 'No hay runner PostgreSQL independiente; el runner E2E disponible requiere RabbitMQ.',
  bulk: 'No hay runner HTTP/PostgreSQL sin RabbitMQ; el benchmark vigente requiere AMQP.',
  'price-audit': 'No hay runner HTTP/PostgreSQL sin RabbitMQ; el benchmark vigente requiere AMQP.',
  taxonomy: 'No hay runner HTTP/PostgreSQL sin RabbitMQ; el runner vigente inicia RabbitMQ.',
};

const selected = scenarioJobs[component] ?? [];
const scenarios = Object.fromEntries(
  selected.map((jobId) => [jobId, jobResults[jobId]?.result ?? 'missing']),
);
const unavailable = unavailableComponents[component];
const complete =
  jobResults.preflight?.result === 'success' &&
  selected.length > 0 &&
  selected.every((jobId) => scenarios[jobId] === 'success');
const result = {
  classification: unavailable
    ? 'NO_DISPONIBLE'
    : complete
      ? 'PASS_SELECTED_SCENARIOS'
      : 'PARTIAL',
  integral: false,
  component,
  scenarios,
  baselineSha: jobResults.preflight?.outputs?.baseline_sha ?? null,
  candidateSha: jobResults.preflight?.outputs?.candidate_sha ?? null,
  limitation: unavailable ?? null,
  runId: process.env.GITHUB_RUN_ID ?? null,
};

await mkdir('.ci/performance/summary', { recursive: true });
await writeFile(
  '.ci/performance/summary/selection-summary.json',
  `${JSON.stringify(result, null, 2)}\n`,
);
console.log(JSON.stringify(result, null, 2));
