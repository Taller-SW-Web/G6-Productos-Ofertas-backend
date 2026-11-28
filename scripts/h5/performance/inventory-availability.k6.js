import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import execution from 'k6/execution';
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
 * - Distribución de SKU sobre grupos reales de manifest.json:
 *   60% disponibles, 15% stock-bajo/en umbral, 10% agotados, 10% no registrados, 5% sin identidad vendible (desactivado en catálogo).
 * - Métricas separadas por operación y código HTTP (2xx, 400, 401/403, 404, 422, 429 APIM, 503, 5xx).
 * - Tasa de errores inesperados < 1%.
 *
 * Perfiles oficiales H5-03:
 *   1VU-60s   → 1 VU,  60s  (smoke exploratorio)
 *   5VU-180s  → 5 VUs, 180s (carga ligera)
 *   20VU-300s → 20 VUs, 300s (carga nominal)
 *
 * BLOQUEO PERF03: si no hay entorno autorizado (BASE_URL vacío), el módulo falla
 * con PERF03_PREFLIGHT_MISSING_BASE_URL — no inventar PASS sin entorno.
 */

const ALLOWED_CHANNELS = new Set(['MARKETPLACE', 'CHATBOT', 'RETAIL']);

/**
 * Perfiles oficiales: cada clave mapea al número EXACTO de VUs total y duración.
 */
const ALLOWED_PROFILES = new Map([
  ['1VU-60s', { vus: 1, duration: '60s' }],
  ['5VU-180s', { vus: 5, duration: '180s' }],
  ['20VU-300s', { vus: 20, duration: '300s' }],
]);

const BASE_URL = (__ENV.BASE_URL ?? '').replace(/\/$/, '');
const CHANNEL = __ENV.CHANNEL ?? 'MARKETPLACE';
const AUTH_TOKEN = __ENV.AUTH_TOKEN ?? __ENV.SYNTHETIC_JWT ?? '';
const DATASET_MANIFEST_PATH =
  __ENV.DATASET_MANIFEST ?? '../fixtures/inventory/out/manifest.json';
const EXPECTED_MANIFEST_SHA256 = __ENV.MANIFEST_SHA256 ?? '';
const PROFILE = __ENV.PROFILE ?? '1VU-60s';
const profileSpec = ALLOWED_PROFILES.get(PROFILE);
const VUS = Number(__ENV.VU ?? __ENV.VUS ?? String(profileSpec?.vus ?? 1));
const DURATION = __ENV.DURATION ?? profileSpec?.duration ?? '60s';
const REPETITION = Number(__ENV.REPETITION ?? '1');
const SYNTHETIC_SMOKE = __ENV.H5_SYNTHETIC_SMOKE === '1';
const MAX_RPS = Number(__ENV.MAX_RPS ?? (SYNTHETIC_SMOKE ? '2' : '0'));
const VERIFY_FULFILLMENT_MODE =
  __ENV.FULFILLMENT_MODE ??
  (CHANNEL === 'RETAIL' ? 'RETIRO_TIENDA' : 'ENVIO_DOMICILIO');

if (!BASE_URL) {
  fail('PERF03_PREFLIGHT_MISSING_BASE_URL');
}
if (!ALLOWED_CHANNELS.has(CHANNEL)) {
  fail(`PERF03_PREFLIGHT_INVALID_CHANNEL_${CHANNEL}`);
}
if (!AUTH_TOKEN) {
  fail('PERF03_PREFLIGHT_MISSING_AUTH_TOKEN');
}
if (SYNTHETIC_SMOKE &&
    (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(BASE_URL) || MAX_RPS !== 2 ||
      PROFILE !== '1VU-60s' || VUS !== 1 || DURATION !== '60s')) {
  fail('PERF03_SYNTHETIC_SMOKE_REQUIRES_LOOPBACK_1VU_60S_AND_2_RPS');
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

/**
 * Distribución de SKU según PERF-03 usando exclusivamente claves reales de manifest.json:
 *   60% disponibles (threshold_plus_one_sku, partial_reserved_sku)
 *   15% stock-bajo / en umbral (exact_threshold_sku, with_blocked_sku)
 *   10% agotados (available_zero_sku, reserved_zero_available_sku)
 *   10% no registrados en Inventory (unregistered_sku)
 *    5% sin identidad vendible / desactivado en catálogo (deactivated_catalog_sku)
 */
const SKUS_AVAILABLE = [
  groups.threshold_plus_one_sku,
  groups.partial_reserved_sku,
].filter(Boolean);
if (SKUS_AVAILABLE.length === 0) {
  SKUS_AVAILABLE.push('SYN-TEST-AVAIL-01');
}

const SKUS_LOW_STOCK = [
  groups.exact_threshold_sku,
  groups.with_blocked_sku,
].filter(Boolean);
if (SKUS_LOW_STOCK.length === 0) {
  SKUS_LOW_STOCK.push('SYN-TEST-LOW-01');
}

const SKUS_ZERO = [
  groups.available_zero_sku,
  groups.reserved_zero_available_sku,
].filter(Boolean);
if (SKUS_ZERO.length === 0) {
  SKUS_ZERO.push('SYN-TEST-ZERO-01');
}

const SKUS_UNREGISTERED = [groups.unregistered_sku].filter(Boolean);
if (SKUS_UNREGISTERED.length === 0) {
  SKUS_UNREGISTERED.push('SYN-TEST-UNREG-99');
}

const SKUS_NON_SELLABLE = [groups.deactivated_catalog_sku].filter(Boolean);
if (SKUS_NON_SELLABLE.length === 0) {
  SKUS_NON_SELLABLE.push('SYN-TEST-DEACT-01');
}

const SKU_GROUPS = {
  available: SKUS_AVAILABLE,
  low_stock: SKUS_LOW_STOCK,
  exhausted: SKUS_ZERO,
  unregistered: SKUS_UNREGISTERED,
  non_sellable: SKUS_NON_SELLABLE,
};
const SKU_GROUP_COUNTERS = {
  available: new Counter('h5_perf03_fixture_available_requests'),
  low_stock: new Counter('h5_perf03_fixture_low_stock_requests'),
  exhausted: new Counter('h5_perf03_fixture_exhausted_requests'),
  unregistered: new Counter('h5_perf03_fixture_unregistered_requests'),
  non_sellable: new Counter('h5_perf03_fixture_non_sellable_requests'),
};
const SYNTHETIC_SAMPLE_GROUPS = [
  ...Array(18).fill('available'), ...Array(4).fill('low_stock'),
  ...Array(3).fill('exhausted'), ...Array(3).fill('unregistered'),
  ...Array(2).fill('non_sellable'),
];
const OFFICIAL_SAMPLE_GROUPS = [
  ...Array(36).fill('available'), ...Array(9).fill('low_stock'),
  ...Array(6).fill('exhausted'), ...Array(6).fill('unregistered'),
  ...Array(3).fill('non_sellable'),
];

/**
 * Selección ponderada de SKU según distribución oficial PERF-03:
 * 60% disponibles, 15% stock-bajo, 10% agotados, 10% no registrados, 5% sin identidad vendible.
 */
function pickSku() {
  const iteration = execution.scenario.iterationInTest;
  const schedule = SYNTHETIC_SMOKE ? SYNTHETIC_SAMPLE_GROUPS : OFFICIAL_SAMPLE_GROUPS;
  const group = schedule[iteration % schedule.length];
  const candidates = SKU_GROUPS[group];
  SKU_GROUP_COUNTERS[group].add(1);
  return candidates[iteration % candidates.length];
}

// Métricas separadas por operación y clasificación HTTP
const get2xx = new Counter('h5_perf03_get_2xx_responses');
const verify2xx = new Counter('h5_perf03_verify_2xx_responses');
const responses400 = new Counter('h5_perf03_bad_request_400_responses');
const responses401or403 = new Counter('h5_perf03_auth_rejected_responses');
const responses404 = new Counter('h5_perf03_not_found_404_responses');
const responses422 = new Counter('h5_perf03_unprocessable_422_responses');
const responses429 = new Counter('h5_perf03_rate_limited_429_responses');
const responses503 = new Counter('h5_perf03_unavailable_503_responses');
const responses5xx = new Counter('h5_perf03_server_5xx_responses');
const unexpectedErrorRate = new Rate('h5_perf03_unexpected_error_rate');
const responseBytes = new Counter('h5_perf03_response_bytes');
const availabilityLatencyMs = new Trend(
  'h5_perf03_availability_duration_ms',
  true,
);
const verifyLatencyMs = new Trend('h5_perf03_verify_duration_ms', true);

/**
 * Cálculo de VUs por escenario.
 * Para 1VU total: ambas operaciones corren en el mismo VU (via default function).
 * Para >1 VU: 70% al GET, 30% al POST verify (mínimo 1 cada uno).
 */
const totalVus = SYNTHETIC_SMOKE ? 1 : VUS;
const getVus = totalVus === 1 ? 1 : Math.max(1, Math.round(totalVus * 0.7));
const verifyVus = totalVus === 1 ? 0 : Math.max(1, totalVus - getVus);
const syntheticDurationSeconds = Number.parseInt(DURATION, 10);
// k6's built-in rps option is an integer. Aim at one request/second here so
// the complete 120-request ceiling cannot be crossed by iteration boundaries.
const syntheticTargetRps = Math.floor(MAX_RPS * 0.95);
const syntheticIterations = Math.floor((syntheticTargetRps * syntheticDurationSeconds) / 2);

export const options =
  totalVus === 1
    ? {
        ...(SYNTHETIC_SMOKE ? { rps: syntheticTargetRps } : {}),
        ...(SYNTHETIC_SMOKE
          ? {
              scenarios: {
                controlled_fixture: {
                  executor: 'per-vu-iterations',
                  vus: 1,
                  iterations: syntheticIterations,
                  maxDuration: DURATION,
                },
              },
            }
          : {
              // Con 1 VU: ejecutor único que corre ambas operaciones en secuencia
              vus: 1,
              duration: DURATION,
            }),
        summaryTrendStats: [
          'avg',
          'min',
          'med',
          'max',
          'p(90)',
          'p(95)',
          'p(99)',
        ],
        thresholds: {
          h5_perf03_unexpected_error_rate: ['rate<0.01'],
          h5_perf03_get_2xx_responses: ['count>0'],
          h5_perf03_verify_2xx_responses: ['count>0'],
          checks: ['rate>0.99'],
        },
      }
    : {
        ...(SYNTHETIC_SMOKE ? { rps: MAX_RPS } : {}),
        scenarios: {
          availability_get: {
            executor: 'constant-vus',
            exec: 'readCommercialAvailability',
            vus: getVus,
            duration: DURATION,
            tags: { scenario_kind: 'GET_DISPONIBILIDAD_COMERCIAL' },
          },
          availability_verify_post: {
            executor: 'constant-vus',
            exec: 'verifyCommercialAvailability',
            vus: verifyVus,
            duration: DURATION,
            tags: { scenario_kind: 'POST_VERIFICAR_CANTIDAD_COMERCIAL' },
          },
        },
        summaryTrendStats: [
          'avg',
          'min',
          'med',
          'max',
          'p(90)',
          'p(95)',
          'p(99)',
        ],
        thresholds: {
          h5_perf03_unexpected_error_rate: ['rate<0.01'],
          h5_perf03_get_2xx_responses: ['count>0'],
          h5_perf03_verify_2xx_responses: ['count>0'],
          checks: ['rate>0.99'],
        },
      };

function recordStatus(res, okCounter) {
  responseBytes.add(res.body ? String(res.body).length : 0);
  const s = res.status;
  if (s >= 200 && s < 300) {
    okCounter.add(1);
    unexpectedErrorRate.add(false);
    return;
  }
  if (s === 400) {
    responses400.add(1);
    unexpectedErrorRate.add(true);
    return;
  }
  if (s === 401 || s === 403) {
    responses401or403.add(1);
    unexpectedErrorRate.add(true);
    return;
  }
  if (s === 404) {
    responses404.add(1);
    unexpectedErrorRate.add(true);
    return;
  }
  if (s === 422) {
    responses422.add(1);
    unexpectedErrorRate.add(true);
    return;
  }
  if (s === 429) {
    responses429.add(1);
    // 429 (rate limit) no es error inesperado — es comportamiento esperado bajo carga
    unexpectedErrorRate.add(false);
    return;
  }
  if (s === 503) {
    responses503.add(1);
    unexpectedErrorRate.add(true);
    return;
  }
  if (s >= 500) {
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
  const sku = pickSku();
  const getRes = http.get(
    `${BASE_URL}/api/v1/inventario/disponibilidad/comercial?skus=${encodeURIComponent(sku)}&canal=${encodeURIComponent(CHANNEL)}`,
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
  recordStatus(getRes, get2xx);

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
  const sku = pickSku();
  const verifyPayload = JSON.stringify({
    channel_id: CHANNEL,
    fulfillment: { mode: VERIFY_FULFILLMENT_MODE },
    lines: [{ sku, quantity: 1 }],
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
  recordStatus(postVerifyRes, verify2xx);

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

/** Función por defecto: usada con 1VU-60s donde ambas operaciones corren secuencialmente. */
export default function () {
  readCommercialAvailability();
  verifyCommercialAvailability();
}

export function handleSummary(data) {
  const outputPath = __ENV.PERF03_SUMMARY_PATH;
  const payload = {
    schema_version: 1,
    case_id: 'PERF-03',
    execution_scope: SYNTHETIC_SMOKE ? 'L1_NEST_FIXTURES_LOOPBACK' : 'PENDING_RUNNER_ADJUDICATION',
    official_h5_03: 'NO_CERTIFICADO',
    h5_criterion: 'H5-03',
    owner: 'Taco',
    platform_owner: 'Vera',
    profile: PROFILE,
    virtual_users: totalVus,
    duration_seconds: Number.parseInt(DURATION, 10),
    max_rps: SYNTHETIC_SMOKE ? MAX_RPS : null,
    synthetic_target_rps: SYNTHETIC_SMOKE ? syntheticTargetRps : null,
    max_requests: SYNTHETIC_SMOKE ? MAX_RPS * Number.parseInt(DURATION, 10) : null,
    runtime_duration_ms: data?.state?.testRunDurationMs ?? null,
    channel: CHANNEL,
    repetition: REPETITION,
    dataset_seed: manifest.seed ?? null,
    manifest_sha256: actualManifestSha256,
    sku_distribution: {
      available: 60,
      low_stock: 15,
      zero: 10,
      unregistered: 10,
      non_sellable: 5,
    },
    fixture_group_request_counts: {
      available: data.metrics.h5_perf03_fixture_available_requests?.values?.count ?? 0,
      low_stock: data.metrics.h5_perf03_fixture_low_stock_requests?.values?.count ?? 0,
      exhausted: data.metrics.h5_perf03_fixture_exhausted_requests?.values?.count ?? 0,
      unregistered: data.metrics.h5_perf03_fixture_unregistered_requests?.values?.count ?? 0,
      non_sellable: data.metrics.h5_perf03_fixture_non_sellable_requests?.values?.count ?? 0,
    },
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
