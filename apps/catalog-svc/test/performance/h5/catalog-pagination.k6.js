import http from 'k6/http';
import { check, fail } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { sha256 } from 'k6/crypto';
import execution from 'k6/execution';
import { COMMERCIAL_CHANNELS, expectedCommercialProducts, validateCommercialCatalogSnapshot } from './catalog-pagination-integrity.mjs';

const BASE_URL = (__ENV.BASE_URL ?? '').replace(/\/$/, '');
const JWT = __ENV.SYNTHETIC_JWT ?? '';
const SOURCE_SHA = __ENV.SOURCE_SHA ?? '';
const DOCS_SHA = 'c9e1e5c217616d28229fccf5315fb97a1ae061a9';
const VUS = Number(__ENV.VU ?? '');
const DURATION = __ENV.DURATION ?? '';
const SEED = Number(__ENV.SEED ?? '');
const CHANNEL = __ENV.CHANNEL ?? '';
const EXPECTED_SHA256 = __ENV.MANIFEST_SHA256 ?? '';
const repetition = Number(__ENV.REPETITION ?? '');
const SYNTHETIC_SMOKE = __ENV.H5_SYNTHETIC_SMOKE === '1';
const manifestBytes = open('../../fixtures/h5/manifest.json');
const manifestChecksum = open('../../fixtures/h5/manifest.sha256').trim();
const actualManifestSha = sha256(manifestBytes, 'hex');
const profile = `${VUS}VU-${DURATION}`;
const unexpectedErrors = new Rate('h5_perf01_unexpected_error_rate');
const responses2xx = new Counter('h5_perf01_2xx_responses');
const responses401 = new Counter('h5_perf01_401_responses');
const responses403 = new Counter('h5_perf01_403_responses');
const responses429 = new Counter('h5_perf01_429_responses');
const responseBytes = new Counter('h5_perf01_response_bytes');
const measuredLatency = new Trend('h5_perf01_catalog_list_duration_ms', true);

const allowedProfiles = new Map([[1, '60s'], [5, '180s'], [20, '300s']]);
if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(BASE_URL)) fail('H5_PREFLIGHT_BASE_URL_MUST_BE_LOOPBACK');
const profileValid = SYNTHETIC_SMOKE ? VUS === 1 && DURATION === '5s' : allowedProfiles.has(VUS) && allowedProfiles.get(VUS) === DURATION;
if (!JWT || !/^[0-9a-f]{40}$/i.test(SOURCE_SHA) || !profileValid || SEED !== 20261123 || !COMMERCIAL_CHANNELS.includes(CHANNEL) || !/^[a-f0-9]{64}$/.test(EXPECTED_SHA256) || !/^[a-f0-9]{64}  manifest\.json$/.test(manifestChecksum) || manifestChecksum.slice(0, 64) !== actualManifestSha || EXPECTED_SHA256 !== actualManifestSha || !Number.isInteger(repetition) || repetition < 1 || repetition > 3)
  fail('H5_PREFLIGHT_CONFIGURATION_OR_MANIFEST_INVALID');

const manifest = JSON.parse(manifestBytes);
const expectedProducts = expectedCommercialProducts(manifest, CHANNEL);
const totalPages = Math.ceil(expectedProducts.length / manifest.pagination.page_size);
const headers = { Authorization: `Bearer ${JWT}`, Accept: 'application/json' };

export const options = {
  vus: VUS,
  duration: DURATION,
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  thresholds: {
    h5_perf01_unexpected_error_rate: ['rate<0.01'],
    h5_perf01_2xx_responses: ['count>0'],
    checks: ['rate>0.99'],
  },
};

function request(path, phase) {
  return http.get(`${BASE_URL}/api/v1${path}`, {
    headers,
    tags: { h5_case: 'PERF-01', channel: CHANNEL, profile, repetition: String(repetition), h5_phase: phase },
  });
}

function readCatalogSnapshot(phase) {
  const pages = [];
  const detailsByProduct = {};
  const pageSize = manifest.pagination.page_size;
  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
    const response = request(`/productos?canal=${encodeURIComponent(CHANNEL)}&pagina=${pageNumber}&tamanio=${pageSize}&orden=NOMBRE_ASC`, phase);
    if (response.status !== 200) {
      console.log(`H5_PERF01_PREFLIGHT_HTTP_STATUS_${response.status}`);
      fail(`H5_PERF01_CATALOG_PREFLIGHT_STATUS_INVALID_${response.status}`);
    }
    const body = response.json();
    if (!Array.isArray(body.items) || body.pagina !== pageNumber || body.tamanio !== pageSize || body.total !== expectedProducts.length)
      fail('H5_PERF01_PAGINATION_METADATA_INVALID');
    pages.push(body);
  }
  for (const product of expectedProducts) {
    if (!product.variants.some(variant => variant.eligible && variant.state === 'ACTIVA')) continue;
    const response = request(`/productos/${encodeURIComponent(product.product_id)}?canal=${encodeURIComponent(CHANNEL)}`, phase);
    if (response.status !== 200) fail('H5_PERF01_COMMERCIAL_DETAIL_STATUS_INVALID');
    detailsByProduct[product.product_id] = response.json();
  }
  const result = validateCommercialCatalogSnapshot({ pages, detailsByProduct, manifest, channel: CHANNEL });
  if (result.status !== 'PASS') fail(`H5_PERF01_SNAPSHOT_${result.findings[0] ?? 'INVALID'}`);
  // Hash only normalized contract fields. k6's JS runtime may normalize parsed
  // JSON object representation differently between lifecycle phases.
  const normalizedPages = pages.map(page => ({
    pagina: page.pagina,
    tamanio: page.tamanio,
    total: page.total,
    items: page.items.map(item => ({
      product_id: item.product_id,
      name: item.name,
      tiene_variantes: item.tiene_variantes,
      sku_base: item.sku_base,
    })),
  }));
  const normalizedDetails = Object.keys(detailsByProduct).sort().map(productId => {
    const detail = detailsByProduct[productId];
    return {
      product_id: detail.product_id,
      sku_base: detail.sku_base,
      variants: (detail.variants ?? []).map(variant => ({ variant_id: variant.variant_id, sku: variant.sku })),
    };
  });
  const digest = sha256(JSON.stringify({ pages: normalizedPages, details: normalizedDetails }), 'hex');
  console.log(`H5_PERF01_SNAPSHOT_${phase.toUpperCase()}_${digest}`);
  return digest;
}

export function setup() {
  const snapshotSha = readCatalogSnapshot('preflight');
  console.log('H5_PERF01_PREFLIGHT_PASS');
  return { snapshotSha, preflightIntegrity: 'PASS' };
}

export default function (setupData) {
  if (setupData?.preflightIntegrity !== 'PASS' || !setupData?.snapshotSha) fail('H5_PERF01_PREFLIGHT_EVIDENCE_MISSING');
  if (totalPages < 1) fail('H5_PERF01_EMPTY_COMMERCIAL_DATASET');
  const iteration = execution.scenario.iterationInTest;
  const page = (iteration % totalPages) + 1;
  const response = request(`/productos?canal=${encodeURIComponent(CHANNEL)}&pagina=${page}&tamanio=${manifest.pagination.page_size}&orden=NOMBRE_ASC`, 'measurement');
  const tags = { h5_case: 'PERF-01', channel: CHANNEL, profile, repetition: String(repetition), h5_phase: 'measurement' };
  if (response.status >= 200 && response.status < 300) responses2xx.add(1, tags);
  if (response.status === 401) responses401.add(1, tags);
  if (response.status === 403) responses403.add(1, tags);
  if (response.status === 429) responses429.add(1, tags);
  const unexpected = response.status !== 200;
  unexpectedErrors.add(unexpected, tags);
  measuredLatency.add(response.timings.duration, tags);
  const lengthHeader = response.headers?.['Content-Length'] ?? response.headers?.['content-length'];
  const transferSize = lengthHeader ? Number(lengthHeader) : new TextEncoder().encode(response.body ?? '').byteLength;
  if (Number.isFinite(transferSize) && transferSize >= 0) responseBytes.add(transferSize, tags);
  check(response, { 'commercial Catalog returns HTTP 200': result => result.status === 200 });
}

export function teardown(data) {
  const afterSha = readCatalogSnapshot('postflight');
  if (!data?.snapshotSha || afterSha !== data.snapshotSha) fail('H5_PERF01_DATASET_CHANGED_DURING_MEASUREMENT');
  console.log('H5_PERF01_POSTFLIGHT_PASS');
}

export function handleSummary(data) {
  const count = data.metrics.h5_perf01_2xx_responses?.values?.count ?? 0;
  const latency = data.metrics.h5_perf01_catalog_list_duration_ms?.values ?? {};
  const errorCount = data.metrics.h5_perf01_unexpected_error_rate?.values?.passes ?? 0;
  const errorRate = data.metrics.h5_perf01_unexpected_error_rate?.values?.rate ?? 0;
  const summary = {
    schema_version: 1,
    case_id: 'PERF-01',
    source_sha: SOURCE_SHA,
    docs_sha: DOCS_SHA,
    dataset_sha256: actualManifestSha,
    dataset_seed: SEED,
    channel: CHANNEL,
    profile,
    repetition,
    measured_phase: 'measurement',
    status_2xx: count,
    responses_401: data.metrics.h5_perf01_401_responses?.values?.count ?? 0,
    responses_403: data.metrics.h5_perf01_403_responses?.values?.count ?? 0,
    responses_429: data.metrics.h5_perf01_429_responses?.values?.count ?? 0,
    p50_ms: latency.med ?? null,
    p95_ms: latency['p(95)'] ?? null,
    p99_ms: latency['p(99)'] ?? null,
    rps_2xx: Number((count / (VUS ? parseInt(DURATION, 10) : 1)).toFixed(4)),
    response_bytes: data.metrics.h5_perf01_response_bytes?.values?.count ?? 0,
    unexpected_errors: errorCount,
    unexpected_error_rate: errorRate,
    // Only the outer runner can observe the k6 process exit code and lifecycle
    // markers. Raw k6 output is never authoritative evidence on its own.
    runtime_iterations: data.metrics.iterations?.values?.count ?? 0,
    status: 'PENDING_RUNNER_ADJUDICATION',
  };
  const serialized = `${JSON.stringify(summary, null, 2)}\n`;
  const output = __ENV.H5_PERF01_EVIDENCE_PATH;
  return output ? { [output]: serialized, stdout: serialized } : { stdout: serialized };
}
