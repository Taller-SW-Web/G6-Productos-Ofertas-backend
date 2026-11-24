import http from 'k6/http';
import { check, fail } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { sha256 } from 'k6/crypto';

const BASE_URL = (__ENV.BASE_URL ?? '').replace(/\/$/, '');
const JWT = __ENV.SYNTHETIC_JWT ?? '';
const VUS = Number(__ENV.VU ?? '');
const DURATION = __ENV.DURATION ?? '';
const SEED = Number(__ENV.SEED ?? '');
const EXPECTED_SHA256 = __ENV.MANIFEST_SHA256 ?? '';
const repetition = Number(__ENV.REPETITION ?? '');
const manifestBytes = open('../../fixtures/h5/manifest.json');
const manifestChecksum = open('../../fixtures/h5/manifest.sha256').trim();
const actualManifestSha = sha256(manifestBytes, 'hex');
const unexpectedErrors = new Rate('h5_unexpected_error_rate');
const authResponses = new Counter('h5_auth_responses');
const throttledResponses = new Counter('h5_throttled_responses');
const responseBytes = new Counter('h5_response_transfer_bytes');
const measuredLatency = new Trend('h5_catalog_list_duration_ms', true);

const allowedProfiles = new Map([[1, '60s'], [5, '180s'], [20, '300s']]);
if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(BASE_URL)) fail('H5_PREFLIGHT_BASE_URL_MUST_BE_LOOPBACK');
if (!JWT || !allowedProfiles.has(VUS) || allowedProfiles.get(VUS) !== DURATION || SEED !== 20261123 || !/^[a-f0-9]{64}$/.test(EXPECTED_SHA256) || !/^[a-f0-9]{64}  manifest\.json$/.test(manifestChecksum) || manifestChecksum.slice(0, 64) !== actualManifestSha || EXPECTED_SHA256 !== actualManifestSha || !Number.isInteger(repetition) || repetition < 1 || repetition > 3)
  fail('H5_PREFLIGHT_CONFIGURATION_OR_MANIFEST_INVALID');

const manifest = JSON.parse(manifestBytes);
const expectedProducts = manifest.products
  .filter(product => product.eligible && product.state === 'ACTIVO')
  .sort((left, right) => left.nombre < right.nombre ? -1 : left.nombre > right.nombre ? 1 : left.product_id < right.product_id ? -1 : left.product_id > right.product_id ? 1 : 0);
const expectedIds = expectedProducts.map(product => product.product_id);
const excluded = new Set(manifest.expected.excluded_product_ids);
const headers = { Authorization: `Bearer ${JWT}`, Accept: 'application/json' };

export const options = { vus: VUS, duration: DURATION, thresholds: { h5_unexpected_error_rate: ['rate<0.01'] } };

function request(path, phase) {
  return http.get(`${BASE_URL}/api/v1${path}`, { headers, tags: { h5_scenario: 'PERF01', h5_phase: phase, repetition: String(repetition) } });
}

function readCatalogSnapshot(phase) {
  const pages = [];
  const pageSize = manifest.pagination.page_size;
  const totalPages = Math.ceil(expectedProducts.length / pageSize);
  for (let page = 1; page <= totalPages; page += 1) {
    const response = request(`/productos/administracion?pagina=${page}&tamanio=${pageSize}`, phase);
    if (response.status !== 200) fail('H5_PERF01_CATALOG_PREFLIGHT_STATUS_INVALID');
    const body = response.json();
    if (!Array.isArray(body.items) || !body.meta || body.meta.pagina !== page || body.meta.tamanio !== pageSize || body.meta.total !== expectedProducts.length || body.meta.totalPaginas !== totalPages)
      fail('H5_PERF01_PAGINATION_METADATA_INVALID');
    pages.push(body);
  }

  const rows = pages.flatMap(page => page.items);
  const ids = rows.map(row => row.productId ?? row.product_id);
  const idSet = new Set(ids);
  if (ids.length !== expectedIds.length || idSet.size !== ids.length || expectedIds.some(id => !idSet.has(id)) || ids.some(id => excluded.has(id)))
    fail('H5_PERF01_PRODUCT_IDENTITY_SET_INVALID');
  const expectedOrder = expectedProducts.map(product => product.product_id);
  if (ids.some((id, index) => id !== expectedOrder[index])) fail('H5_PERF01_STABLE_ORDER_INVALID');

  for (const expected of expectedProducts) {
    const actual = rows.find(row => (row.productId ?? row.product_id) === expected.product_id);
    if (!actual || actual.nombre !== expected.nombre || (actual.skuBase ?? actual.sku_base) !== expected.sku_base) fail('H5_PERF01_PRODUCT_OR_SKU_BASE_MISMATCH');
  }

  const actualSellable = [];
  for (const product of expectedProducts) {
    if (!product.variants.length) {
      actualSellable.push(`${product.product_id}:base:${product.sku_base}`);
      continue;
    }
    const response = request(`/productos/${encodeURIComponent(product.product_id)}/variantes?pagina=1&tamanio=200&estado=ACTIVA`, phase);
    if (response.status !== 200) fail('H5_PERF01_VARIANT_PREFLIGHT_STATUS_INVALID');
    const body = response.json();
    if (!Array.isArray(body.items)) fail('H5_PERF01_VARIANT_BODY_INVALID');
    const eligible = product.variants.filter(variant => variant.eligible && variant.state === 'ACTIVA');
    if (body.items.length !== eligible.length) fail('H5_PERF01_VARIANT_COUNT_INVALID');
    for (const row of body.items) {
      const variantId = row.variant_id ?? row.variantId;
      const expectedVariant = eligible.find(item => item.variant_id === variantId && item.sku === row.sku);
      if (!expectedVariant) fail('H5_PERF01_VARIANT_IDENTITY_INVALID');
      actualSellable.push(`${product.product_id}:${variantId}:${row.sku}`);
    }
  }
  const expectedSellable = manifest.expected.sellable_skus.map(item => `${item.product_id}:${item.variant_id ?? 'base'}:${item.sku}`).sort();
  if (new Set(actualSellable).size !== actualSellable.length || actualSellable.sort().join('\n') !== expectedSellable.join('\n'))
    fail('H5_PERF01_SELLABLE_SKU_SET_INVALID');
  return sha256(JSON.stringify({ ids, actualSellable: actualSellable.sort() }), 'hex');
}

export function setup() {
  const snapshotSha = readCatalogSnapshot('preflight');
  return { snapshotSha };
}

export default function () {
  const response = request(`/productos/administracion?pagina=1&tamanio=${manifest.pagination.page_size}`, 'measurement');
  if (response.status === 401 || response.status === 403) authResponses.add(1);
  if (response.status === 429) throttledResponses.add(1);
  unexpectedErrors.add(response.status !== 200);
  measuredLatency.add(response.timings.duration);
  const lengthHeader = response.headers?.['Content-Length'] ?? response.headers?.['content-length'];
  responseBytes.add(lengthHeader ? Number(lengthHeader) : new TextEncoder().encode(response.body ?? '').byteLength);
  check(response, { 'Catalog contract returns 200': result => result.status === 200 });
}

export function teardown(data) {
  const afterSha = readCatalogSnapshot('postflight');
  if (!data?.snapshotSha || afterSha !== data.snapshotSha) fail('H5_PERF01_DATASET_CHANGED_DURING_MEASUREMENT');
}
