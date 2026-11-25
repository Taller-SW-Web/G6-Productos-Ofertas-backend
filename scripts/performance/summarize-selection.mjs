import { mkdir, writeFile } from 'node:fs/promises';

const component = process.env.COMPONENT;
const includeLegacyCombos = process.env.INCLUDE_LEGACY_COMBOS === 'true';
const jobResults = JSON.parse(process.env.JOB_RESULTS ?? '{}');
const scenarioJobs = {
  catalog: ['catalog_http_performance'],
  pricing: ['pricing_individual_http_performance'],
  combos: includeLegacyCombos
    ? ['combos_h5_http_performance', 'combos_pricing_http_performance']
    : ['combos_h5_http_performance'],
};

const selected = scenarioJobs[component] ?? [];
const scenarios = Object.fromEntries(
  selected.map((jobId) => [jobId, jobResults[jobId]?.result ?? 'missing']),
);
const h5Result =
  component === 'combos'
    ? (jobResults.combos_h5_http_performance?.result ?? 'missing')
    : undefined;
const legacyResult =
  component === 'combos' && includeLegacyCombos
    ? (jobResults.combos_pricing_http_performance?.result ?? 'missing')
    : undefined;
const complete =
  jobResults.preflight?.result === 'success' &&
  selected.length > 0 &&
  selected.every((jobId) => scenarios[jobId] === 'success') &&
  (component !== 'combos' || h5Result === 'success');
const result = {
  classification: complete ? 'PASS_SELECTED_SCENARIOS' : 'PARTIAL',
  performanceClassification: 'SIN_UMBRAL_APROBADO',
  integral: false,
  component,
  scenarios,
  ...(component === 'combos'
    ? {
        combosScenarios: {
          h5Default: {
            job: 'combos_h5_http_performance',
            result: h5Result,
          },
          legacyOptIn: {
            enabled: includeLegacyCombos,
            job: 'combos_pricing_http_performance',
            result: includeLegacyCombos ? legacyResult : 'not_requested',
          },
        },
      }
    : {}),
  baselineSha: jobResults.preflight?.outputs?.baseline_sha ?? null,
  candidateSha: jobResults.preflight?.outputs?.candidate_sha ?? null,
  limitation:
    component === 'combos'
      ? 'SIN_UMBRAL_APROBADO; fixtures HTTP locales no productivos y sin Azure Service Bus real.'
      : null,
  runId: process.env.GITHUB_RUN_ID ?? null,
};

await mkdir('.ci/performance/summary', { recursive: true });
await writeFile(
  '.ci/performance/summary/selection-summary.json',
  `${JSON.stringify(result, null, 2)}\n`,
);
console.log(JSON.stringify(result, null, 2));
