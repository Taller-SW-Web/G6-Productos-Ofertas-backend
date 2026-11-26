import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { sha256 } from 'k6/crypto';

/**
 * PERF-03 — Escenario modular k6 de disponibilidad comercial de Inventory.
 * Owner: Miguel Taco | Plataforma e integración sistémica: Vera (performance-g6.yml).
 *
 * - Distribución por escenarios separados:
 *   1) `availability_get` (lectura GET /api/v1/inventario/disponibilidad/comercial, 70% peso)
 *   2) `availability_verify_post` (verificación read-only POST /api/v1/inventario/disponibilidad/comercial/verificar, 30% peso)
 * - PROHIBIDO lanzar POST /reservas durante la carga.
 * - Métricas separadas por operación y código HTTP (2xx, 401/403, 404/422, 429 APIM, 5xx) y tasa de errores inesperados (<1%).
 */

const BASE_URL = (__ENV.BASE_URL ?? '').replace(/\/$/, '');
const CHANNEL = __ENV.CHANNEL ?? 'MARKETPLACE';
const AUTH_TOKEN = __ENV.AUTH_TOKEN ?? __ENV.SYNTHETIC_JWT ?? '';
const DATASET_MANIFEST_PATH =
  __ENV.DATASET_MANIFEST ?? '../../fixtures/inventory/out/manifest.json';
const EXPECTED_MANIFEST_SHA256 = __ENV.MANIFEST_SHA256 ?? '';
const PROFILE = __ENV.PROFILE ?? '1VU-60s';
const VUS = Number(__ENV.VU ?? __ENV.VUS ?? '1');
const DURATION = __ENV.DURATION ?? '60s';
const REPETITION = Number(__ENV.REPETITION ?? '1');
const SYNTHETIC_SMOKE = __ENV.H5_SYNTHETIC_SMOKE === '1';
const VERIFY_FULFILLMENT_MODE =
  __ENV.FULFILLMENT_MODE ??
  (CHANNEL === 'RETAIL' ? 'RETIRO_TIENDA' : 'ENVIO_DOMICILIO');

const ALLOWED_CHANNELS = new Set(['MARKETPLACE', 'CHATBOT', 'RETAIL']);
const ALLOWED_PROFILES = new Map([
  ['1VU-60s', { vus: 1, duration: '60s' }],
  ['5VU-180s', { vus: 5, duration: '180s' }],
  ['20VU-300s', { vus: 20, duration: '300s' }],
]);

if (!BASE_URL) {
  fail('PERF03_PREFLIGHT_MISSING_BASE_URL');
}
if (!ALLOWED_CHANNELS.has(CHANNEL)) {
  fail(`PERF03_PREFLIGHT_INVALID_CHANNEL_${CHANNEL}`);
}
if (!AUTH_TOKEN) {
  fail('PERF03_PREFLIGHT_MISSING_AUTH_TOKEN');
}
if (!SYNTHETIC_SMOKE) {
  const expected = ALLOWED_PROFILES.get(PROFILE);
  if (
    !expected ||
    VUS !== expected.vus ||
    DURATION !== expected.duration ||
    !Number.isInteger(REPETITION) ||
    REPETITION < 1 ||
    REPETITION > 3
  ) {
    fail(`PERF03_PREFLIGHT_INVALID_PROFILE_${PROFILE}`);
  }
}

const manifestRaw = open(DATASET_MANIFEST_PATH);
const actualManifestSha256 = sha256(manifestRaw, 'hex');
if (
  EXPECTED_MANIFEST_SHA256 &&
  EXPECTED_MANIFEST_SHA256 !== actualManifestSha256
) {
  fail('PERF03_PREFLIGHT_MANIFEST_SHA256_MISMATCH');
}

const manifest = JSON.parse(manifestRaw);
const groups = manifest.mandatory_groups ?? {};

const AVAILABLE_SKUS = [
  groups.threshold_plus_one_sku ?? 'SYN-TEST-AVAIL-01',
  groups.exact_threshold_sku ?? 'SYN-TEST-LOW-01',
];
const ZERO_OR_MISSING_SKUS = [
  groups.available_zero_sku ?? 'SYN-TEST-ZERO-01',
  groups.unregistered_sku ?? 'SYN-TEST-UNREG-99',
];

// Métricas separadas por operación y clasificación HTTP
const get2xx = new Counter('h5_perf03_get_2xx_responses');
const verify2xx = new Counter('h5_perf03_verify_2xx_responses');
const responses401or403 = new Counter('h5_perf03_auth_rejected_responses');
const responses404or422 = new Counter('h5_perf03_contract_rejected_responses');
const responses429 = new Counter('h5_perf03_rate_limited_429_responses');
const responses5xx = new Counter('h5_perf03_server_5xx_responses');
const unexpectedErrorRate = new Rate('h5_perf03_unexpected_error_rate');
const responseBytes = new Counter('h5_perf03_response_bytes');
const availabilityLatencyMs = new Trend(
  'h5_perf03_availability_duration_ms',
  true,
);
const verifyLatencyMs = new Trend('h5_perf03_verify_duration_ms', true);

const getVus = Math.max(1, Math.round(VUS * 0.7));
const verifyVus = Math.max(1, VUS - getVus);

export const options = {
  scenarios: {
    availability_get: {
      executor: 'constant-vus',
      exec: 'readCommercialAvailability',
      vus: SYNTHETIC_SMOKE ? 1 : getVus,
      duration: DURATION,
      tags: { scenario_kind: 'GET_DISPONIBILIDAD_COMERCIAL' },
    },
    availability_verify_post: {
      executor: 'constant-vus',
      exec: 'verifyCommercialAvailability',
      vus: SYNTHETIC_SMOKE ? 1 : verifyVus,
      duration: DURATION,
      tags: { scenario_kind: 'POST_VERIFICAR_CANTIDAD_COMERCIAL' },
    },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  thresholds: {
    h5_perf03_unexpected_error_rate: ['rate<0.01'],
    h5_perf03_get_2xx_responses: ['count>0'],
    h5_perf03_verify_2xx_responses: ['count>0'],
    checks: ['rate>0.99'],
  },
};

function recordStatus(res, okCounter, expect2xx = true) {
  responseBytes.add(res.body ? String(res.body).length : 0);
  if (res.status >= 200 && res.status < 300) {
    okCounter.add(1);
    unexpectedErrorRate.add(false);
    return;
  }
  if (res.status === 401 || res.status === 403) {
    responses401or403.add(1);
    unexpectedErrorRate.add(expect2xx);
    return;
  }
  if (res.status === 404 || res.status === 422) {
    responses404or422.add(1);
    unexpectedErrorRate.add(expect2xx);
    return;
  }
  if (res.status === 429) {
    responses429.add(1);
    unexpectedErrorRate.add(false);
    return;
  }
  if (res.status >= 500) {
    responses5xx.add(1);
    unexpectedErrorRate.add(true);
    return;
  }
  unexpectedErrorRate.add(true);
}

function buildHeaders() {
  return {
    Authorization: `Bearer ${AUTH_TOKEN}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

export function readCommercialAvailability() {
  const skusParam = [...AVAILABLE_SKUS, ...ZERO_OR_MISSING_SKUS]
    .map((sku) => encodeURIComponent(sku))
    .join(',');
  const getRes = http.get(
    `${BASE_URL}/api/v1/inventario/disponibilidad/comercial?skus=${skusParam}&canal=${encodeURIComponent(CHANNEL)}`,
    {
      headers: buildHeaders(),
      tags: {
        h5_case: 'PERF-03',
        operation: 'GET_DISPONIBILIDAD_COMERCIAL',
        channel: CHANNEL,
        profile: PROFILE,
        repetition: String(REPETITION),
      },
    },
  );
  availabilityLatencyMs.add(getRes.timings.duration);
  recordStatus(getRes, get2xx, true);

  check(getRes, {
    'GET disponibilidad comercial status 200 o 429': (r) =>
      r.status === 200 || r.status === 429,
    'GET disponibilidad comercial no filtra stock interno': (r) =>
      r.status !== 200 ||
      !/on_hand|reserved|blocked|stock_version/.test(String(r.body)),
  });

  if (SYNTHETIC_SMOKE) sleep(0.05);
}

export function verifyCommercialAvailability() {
  const verifyPayload = JSON.stringify({
    channel_id: CHANNEL,
    fulfillment: { mode: VERIFY_FULFILLMENT_MODE },
    lines: [{ sku: AVAILABLE_SKUS[0], quantity: 1 }],
  });
  const postVerifyRes = http.post(
    `${BASE_URL}/api/v1/inventario/disponibilidad/comercial/verificar`,
    verifyPayload,
    {
      headers: buildHeaders(),
      tags: {
        h5_case: 'PERF-03',
        operation: 'POST_VERIFICAR_CANTIDAD_COMERCIAL',
        channel: CHANNEL,
        profile: PROFILE,
        repetition: String(REPETITION),
      },
    },
  );
  verifyLatencyMs.add(postVerifyRes.timings.duration);
  recordStatus(postVerifyRes, verify2xx, true);

  check(postVerifyRes, {
    'POST verificar cantidad status 200 o 429': (r) =>
      r.status === 200 || r.status === 429,
    'POST verificar cantidad binding === false': (r) => {
      if (r.status !== 200) return true;
      try {
        return r.json('binding') === false;
      } catch {
        return false;
      }
    },
  });

  if (SYNTHETIC_SMOKE) sleep(0.05);
}

export default function () {
  readCommercialAvailability();
  verifyCommercialAvailability();
}

export function handleSummary(data) {
  const outputPath = __ENV.PERF03_SUMMARY_PATH;
  const payload = {
    case_id: 'PERF-03',
    h5_criterion: 'H5-03',
    owner: 'Taco',
    platform_owner: 'Vera',
    profile: PROFILE,
    channel: CHANNEL,
    repetition: REPETITION,
    dataset_seed: manifest.seed ?? null,
    manifest_sha256: actualManifestSha256,
    metrics: data.metrics,
  };
  if (outputPath) {
    return {
      [outputPath]: JSON.stringify(payload, null, 2),
      stdout: JSON.stringify(payload, null, 2),
    };
  }
  return {
    stdout: JSON.stringify(payload, null, 2),
  };
}
