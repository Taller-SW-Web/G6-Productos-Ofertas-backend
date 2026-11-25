import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { constanciaComercial } from './evidencia-integracion.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const sha = /^[a-f0-9]{40}$/i;
const digest = /^sha256:[a-f0-9]{64}$/i;
const cdServices = [
  'api-gateway',
  'catalog-svc',
  'inventory-svc',
  'promotions-svc',
];
const globalFields = [
  'environment',
  'gateway',
  'g6_sha',
  'g6_service_shas',
  'g6_cd_runs',
  'g6_destination',
  'g5_sha',
  'g5_deployment',
];
const caseFields = [
  'order_id',
  'foreign_order_id',
  'scenario',
  'customer_ref',
  'effective_at',
  'reservation_id',
  'g5_snapshot_confirmed',
  'follow_type',
  'follow_operation_id',
  'expected_restore_outcome',
  'expected_reserve_status',
  'fixture_origin',
  'operations',
  'g5_evidence',
  'message_ids',
];
const fail = (code) => {
  throw new Error(code);
};
const requiredString = (value, code) => {
  if (typeof value !== 'string' || !value.trim() || value.startsWith('<'))
    fail(code);
  return value;
};

function ensureNoCredentials(value, path = '') {
  if (Array.isArray(value))
    return value.forEach((item, index) =>
      ensureNoCredentials(item, `${path}[${index}]`),
    );
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (/(?:jwt|bearer|access.?token|secret|private.?key)/i.test(key))
      fail('CREDENTIALS_NOT_ALLOWED_IN_PLAN_PROFILE');
    ensureNoCredentials(item, path ? `${path}.${key}` : key);
  }
}

function validateG5Deployment(profile) {
  const evidence = profile.g5_deployment;
  if (
    !evidence ||
    evidence.verification_status !== 'VERIFIED' ||
    evidence.commit_sha !== profile.g5_sha ||
    !digest.test(evidence.image_digest ?? '') ||
    !requiredString(evidence.revision, 'G5_DEPLOYMENT_REVISION_REQUIRED') ||
    !requiredString(evidence.verified_by, 'G5_DEPLOYMENT_VERIFIER_REQUIRED') ||
    !Number.isFinite(Date.parse(evidence.verified_at))
  )
    fail('G5_DEPLOYMENT_EVIDENCE_REQUIRED');
  let url;
  try {
    url = new URL(evidence.evidence_url);
  } catch {
    fail('G5_DEPLOYMENT_EVIDENCE_REQUIRED');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    fail('G5_DEPLOYMENT_EVIDENCE_REQUIRED');
}

async function validateG5Signature(evidence, scenario, plan, profile) {
  if (
    !evidence ||
    typeof evidence.payload !== 'string' ||
    typeof evidence.signature !== 'string' ||
    !/^[A-Za-z0-9_-]+$/.test(evidence.payload) ||
    !/^[A-Za-z0-9_-]+$/.test(evidence.signature)
  )
    fail(`SIGNED_G5_EVIDENCE_REQUIRED_${scenario.id}`);
  let payload;
  try {
    payload = JSON.parse(
      Buffer.from(evidence.payload, 'base64url').toString('utf8'),
    );
  } catch {
    fail(`SIGNED_G5_EVIDENCE_INVALID_${scenario.id}`);
  }
  const expectedEvent =
    scenario.id === 'G5-H5-03' ? 'PAGO_CONFIRMADO' : 'ANULACION_CONFIRMADA';
  const expectedCouponOperation = ['G5-H5-04'].includes(scenario.id)
    ? null
    : plan.operations?.coupon;
  if (
    payload.issuer !== 'G5' ||
    payload.event !== expectedEvent ||
    payload.environment !== 'integration' ||
    payload.order_id !== plan.order_id ||
    payload.g5_sha !== profile.g5_sha ||
    payload.g6_sha !== profile.g6_sha ||
    payload.reservation_id !== plan.reservation_id ||
    payload.coupon_operation_id !== expectedCouponOperation ||
    !Number.isFinite(Date.parse(payload.occurred_at)) ||
    payload.gateway !== new URL(profile.gateway).origin
  )
    fail(`SIGNED_G5_EVIDENCE_MISMATCH_${scenario.id}`);
  await constanciaComercial(plan, expectedEvent);
}

async function validateAuthorized(profile, plans, scenarios, selectedIds) {
  if (
    profile.environment !== 'integration' ||
    !sha.test(profile.g6_sha ?? '') ||
    !sha.test(profile.g5_sha ?? '')
  )
    fail('INTEGRATION_SHAS_REQUIRED');
  if (!['brazil-isolated', 'chile-shared'].includes(profile.g6_destination))
    fail('G6_DEPLOYMENT_DESTINATION_REQUIRED');
  if (
    profile.g6_service_shas !== undefined &&
    (typeof profile.g6_service_shas !== 'object' ||
      cdServices.some(
        (service) => !sha.test(profile.g6_service_shas[service] ?? ''),
      ))
  )
    fail('G6_SERVICE_SHAS_INVALID');
  let gateway;
  try {
    gateway = new URL(profile.gateway);
  } catch {
    fail('AUTHORIZED_PRIVATE_GATEWAY_REQUIRED');
  }
  if (
    gateway.protocol !== 'https:' ||
    gateway.username ||
    gateway.password ||
    gateway.search ||
    gateway.hash ||
    (profile.gateway !== gateway.origin &&
      profile.gateway !== `${gateway.origin}/`)
  )
    fail('AUTHORIZED_PRIVATE_GATEWAY_REQUIRED');
  for (const service of cdServices)
    if (!/^[1-9][0-9]{0,15}$/.test(String(profile.g6_cd_runs?.[service])))
      fail('FOUR_G6_CD_RUNS_REQUIRED');
  if (
    new Set(cdServices.map((service) => String(profile.g6_cd_runs[service])))
      .size !== cdServices.length
  )
    fail('FOUR_DISTINCT_G6_CD_RUNS_REQUIRED');
  validateG5Deployment(profile);
  for (const id of selectedIds) {
    const scenario = scenarios.find((entry) => entry.id === id);
    const plan = plans.get(id);
    const input = profile.cases?.[id] ?? {};
    if (!plan || !scenario) fail(`CASE_PLAN_REQUIRED_${id}`);
    if (scenario.requires_order)
      requiredString(plan.order_id, `G5_SYNTHETIC_ORDER_REQUIRED_${id}`);
    if (scenario.requires_order && id === 'G5-H5-13') {
      requiredString(
        plan.auth?.foreign_order_id,
        'FOREIGN_ORDER_REQUIRED_G5_H5_13',
      );
      if (plan.auth.foreign_order_id === plan.order_id)
        fail('FOREIGN_ORDER_MUST_DIFFER');
    }
    if (scenario.requires_scenario) {
      const commercial = plan.scenario;
      if (
        !commercial ||
        typeof commercial.sku !== 'string' ||
        !commercial.sku.trim() ||
        !Number.isSafeInteger(commercial.quantity) ||
        commercial.quantity < 1 ||
        typeof commercial.channel_id !== 'string' ||
        !commercial.channel_id.trim() ||
        typeof commercial.coupon_code !== 'string' ||
        !commercial.coupon_code.trim() ||
        typeof commercial.currency !== 'string' ||
        !commercial.currency.trim() ||
        (commercial.expected_regular_price !== undefined &&
          (typeof commercial.expected_regular_price !== 'string' ||
            !/^\d+(?:\.\d{1,6})?$/.test(commercial.expected_regular_price) ||
            Number(commercial.expected_regular_price) <= 0)) ||
        !uuid.test(commercial.location_id ?? '') ||
        !uuid.test(plan.customer_ref ?? '')
      )
        fail(`AUTHORIZED_COMMERCIAL_FIXTURE_REQUIRED_${id}`);
    }
    if (
      scenario.requires_snapshot &&
      (plan.g5_snapshot_confirmed !== true ||
        !uuid.test(plan.customer_ref ?? '') ||
        !Number.isFinite(Date.parse(plan.effective_at)))
    )
      fail(`CONFIRMED_G5_SNAPSHOT_REQUIRED_${id}`);
    if (
      scenario.requires_existing_coupon &&
      !uuid.test(plan.operations?.coupon ?? '')
    )
      fail(`EXISTING_COUPON_OPERATION_REQUIRED_${id}`);
    if (
      scenario.requires_follow_operation &&
      (!uuid.test(plan.follow_operation_id ?? '') ||
        !['cupones', 'inventario'].includes(plan.follow_type))
    )
      fail(`EXISTING_FOLLOW_OPERATION_REQUIRED_${id}`);
    if (scenario.requires_g5_signature)
      await validateG5Signature(plan.g5_evidence, scenario, plan, profile);
    if (id === 'G5-H5-06')
      requiredString(
        plan.expected_restore_outcome,
        'RESTORE_OUTCOME_REQUIRED_G5_H5_06',
      );
    if (
      [
        'G5-H5-10',
        'G5-H5-11',
        'G5-H5-03',
        'G5-H5-04',
        'G5-H5-05',
        'G5-H5-06',
      ].includes(id) &&
      !uuid.test(plan.reservation_id ?? '')
    )
      fail(`RESERVATION_REQUIRED_${id}`);
    if (
      id === 'G5-H5-13' &&
      !uuid.test(plan.auth?.existing_coupon_operation_id ?? '')
    )
      fail('EXISTING_COUPON_OPERATION_REQUIRED_G5_H5_13');
    if (
      id === 'G5-H5-20' &&
      (!Array.isArray(plan.message_ids) ||
        !plan.message_ids.length ||
        plan.message_ids.some((messageId) => !uuid.test(messageId)))
    )
      fail('MESSAGE_IDS_REQUIRED_G5_H5_20');
    if (input.execute === true || plan.execute !== false)
      fail('EXECUTE_MUST_REMAIN_FALSE');
  }
}

function generatedOperationNames(scenario) {
  if (scenario.id === 'G5-H5-04') return ['release'];
  if (scenario.id === 'G5-H5-06') return ['restore', 'release'];
  if (
    scenario.requires_existing_coupon ||
    scenario.requires_follow_operation ||
    scenario.stage === 'auth' ||
    scenario.stage === 'expired'
  )
    return [];
  return scenario.stage &&
    ['reserve', 'coupon', 'confirm', 'cancel'].includes(scenario.stage)
    ? [scenario.stage === 'cancel' ? 'release' : scenario.stage]
    : [];
}

function planFromKnown(profile, input, scenario) {
  const operations = {};
  for (const name of generatedOperationNames(scenario)) {
    operations[name] = input.operations?.[name] ?? randomUUID();
  }
  for (const [name, value] of Object.entries(input.operations ?? {})) {
    if (!operations[name]) operations[name] = value;
  }
  for (const id of Object.values(operations))
    if (!uuid.test(id)) fail(`INVALID_OPERATION_ID_${scenario.id}`);
  const plan = {
    case_id: scenario.id,
    authorization_status: 'PREPARED',
    execute: false,
    environment: profile.environment ?? 'integration',
    correlation_id: input.correlation_id ?? randomUUID(),
    operations,
  };
  for (const field of globalFields)
    if (profile[field] !== undefined) plan[field] = profile[field];
  for (const field of caseFields)
    if (input[field] !== undefined)
      plan[field] =
        field === 'operations'
          ? { ...plan.operations, ...input.operations }
          : input[field];
  if (scenario.id === 'G5-H5-13' && input.foreign_order_id)
    plan.auth = {
      foreign_order_id: input.foreign_order_id,
      ...(input.existing_coupon_operation_id
        ? { existing_coupon_operation_id: input.existing_coupon_operation_id }
        : {}),
    };
  if (scenario.id === 'G5-H5-04') plan.cancel_mode = 'release-only';
  if (scenario.id === 'G5-H5-06') plan.cancel_mode = 'restore-consumption';
  return plan;
}

function mergeKnown(plan, patch, path = '') {
  for (const [key, value] of Object.entries(patch)) {
    const fullPath = path ? `${path}.${key}` : key;
    if (
      key === 'execute' ||
      key === 'authorization_status' ||
      key === 'case_id'
    )
      fail('PLAN_CONTROL_FIELDS_CANNOT_BE_UPDATED');
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (plan[key] === undefined) plan[key] = {};
      if (
        !plan[key] ||
        typeof plan[key] !== 'object' ||
        Array.isArray(plan[key])
      )
        fail(`CONTRADICTORY_PLAN_FIELD_${fullPath}`);
      mergeKnown(plan[key], value, fullPath);
    } else if (plan[key] === undefined) plan[key] = value;
    else if (JSON.stringify(plan[key]) !== JSON.stringify(value))
      fail(`CONTRADICTORY_PLAN_FIELD_${fullPath}`);
  }
}

function validateGlobalIdentifiers(plans, scenarios) {
  const orders = scenarios
    .filter((item) => item.requires_order)
    .map((item) => plans.get(item.id)?.order_id)
    .filter(Boolean);
  if (new Set(orders).size !== orders.length)
    fail('EACH_SCENARIO_REQUIRES_AN_ISOLATED_ORDER');
  const correlations = scenarios
    .map((item) => plans.get(item.id)?.correlation_id)
    .filter(Boolean);
  if (new Set(correlations).size !== correlations.length)
    fail('CORRELATION_UUID_REUSED_ACROSS_SCENARIOS');
  const operations = scenarios
    .flatMap((item) => [
      ...Object.values(plans.get(item.id)?.operations ?? {}),
      plans.get(item.id)?.follow_operation_id,
      plans.get(item.id)?.auth?.existing_coupon_operation_id,
      ...(plans.get(item.id)?.message_ids ?? []),
    ])
    .filter(Boolean);
  if (new Set(operations).size !== operations.length)
    fail('OPERATION_UUID_REUSED_ACROSS_SCENARIOS');
  const reservations = scenarios
    .map((item) => plans.get(item.id)?.reservation_id)
    .filter(Boolean);
  if (new Set(reservations).size !== reservations.length)
    fail('RESERVATION_UUID_REUSED_ACROSS_SCENARIOS');
  for (const item of scenarios) {
    const plan = plans.get(item.id);
    if (
      !uuid.test(plan?.correlation_id ?? '') ||
      Object.values(plan.operations ?? {}).some((id) => !uuid.test(id))
    )
      fail(`PLAN_UUID_INVALID_${item.id}`);
  }
}

async function writeAtomic(path, data) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, data, { flag: 'wx' });
  await rename(temp, path);
}

export async function prepararPlanes(
  profile,
  outputDir,
  scenarioFile,
  mode = 'prepare',
  authorizeIds = [],
) {
  ensureNoCredentials(profile);
  if (
    profile.execute === true ||
    Object.values(profile.cases ?? {}).some((input) => input?.execute === true)
  )
    fail('EXECUTE_MUST_REMAIN_FALSE');
  const scenarios = JSON.parse(await readFile(scenarioFile, 'utf8'));
  const root = resolve(outputDir);
  if (mode === 'prepare') {
    const manifest = {};
    const plans = new Map();
    for (const scenario of scenarios)
      plans.set(
        scenario.id,
        planFromKnown(profile, profile.cases?.[scenario.id] ?? {}, scenario),
      );
    validateGlobalIdentifiers(plans, scenarios);
    await mkdir(root, { recursive: false });
    for (const [id, plan] of plans) {
      const name = `${id}.json`;
      const state = `${id}.runtime.json`;
      await writeFile(
        resolve(root, name),
        JSON.stringify(plan, null, 2) + '\n',
        { flag: 'wx' },
      );
      manifest[id] = { plan: name, state, execute: false };
    }
    const manifestPath = resolve(root, 'manifiesto.azure.json');
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', {
      flag: 'wx',
    });
    return {
      phase: 'PREPARED',
      outputDir: root,
      cases: scenarios.length,
      manifest: manifestPath,
    };
  }
  if (!['update', 'authorize'].includes(mode)) fail('PLAN_MODE_INVALID');
  const manifestPath = resolve(root, 'manifiesto.azure.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const plans = new Map();
  for (const scenario of scenarios) {
    const entry = manifest[scenario.id];
    if (!entry?.plan) fail(`CASE_PLAN_REQUIRED_${scenario.id}`);
    const path = resolve(root, entry.plan);
    plans.set(scenario.id, JSON.parse(await readFile(path, 'utf8')));
  }
  const updates = [];
  for (const scenario of scenarios) {
    const plan = plans.get(scenario.id);
    const input = profile.cases?.[scenario.id] ?? {};
    if (profile.execute === true || input.execute === true)
      fail('EXECUTE_MUST_REMAIN_FALSE');
    const patch = {};
    for (const field of globalFields)
      if (profile[field] !== undefined) patch[field] = profile[field];
    for (const field of caseFields)
      if (input[field] !== undefined) patch[field] = input[field];
    if (scenario.id === 'G5-H5-13' && input.foreign_order_id) {
      patch.auth = {
        ...(plan.auth ?? {}),
        foreign_order_id: input.foreign_order_id,
        ...(input.existing_coupon_operation_id
          ? { existing_coupon_operation_id: input.existing_coupon_operation_id }
          : {}),
      };
    }
    mergeKnown(plan, patch);
    if (scenario.id === 'G5-H5-04' && plan.cancel_mode !== 'release-only')
      fail('CASE_04_RELEASE_ONLY_REQUIRED');
    if (
      scenario.id === 'G5-H5-06' &&
      plan.cancel_mode !== 'restore-consumption'
    )
      fail('CASE_06_RESTORE_MODE_REQUIRED');
    updates.push([resolve(root, manifest[scenario.id].plan), plan]);
  }
  validateGlobalIdentifiers(plans, scenarios);
  if (mode === 'authorize') {
    if (
      !authorizeIds.length ||
      authorizeIds.some(
        (id) => !scenarios.some((scenario) => scenario.id === id),
      )
    )
      fail('AUTHORIZED_CASE_IDS_REQUIRED');
    await validateAuthorized(profile, plans, scenarios, authorizeIds);
    for (const id of authorizeIds)
      plans.get(id).authorization_status = 'AUTHORIZED';
  }
  for (const [path, plan] of updates)
    await writeAtomic(path, JSON.stringify(plan, null, 2) + '\n');
  return {
    phase: mode === 'authorize' ? 'AUTHORIZED' : 'PREPARED',
    outputDir: root,
    cases: scenarios.length,
    authorized: mode === 'authorize' ? authorizeIds : [],
    manifest: manifestPath,
  };
}

async function main() {
  const [mode, profilePath, outputDir, ...authorizeIds] = process.argv.slice(2);
  if (
    !['prepare', 'update', 'authorize'].includes(mode) ||
    !profilePath ||
    !outputDir
  )
    fail(
      'USO: preparar-planes.mjs <prepare|update|authorize> perfil.json directorio [G5-H5-NN ...]',
    );
  const profile = JSON.parse(await readFile(profilePath, 'utf8'));
  const result = await prepararPlanes(
    profile,
    outputDir,
    resolve(here, 'escenarios.json'),
    mode,
    authorizeIds,
  );
  console.log(JSON.stringify(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    const code = /^[A-Z0-9_-]{1,100}$/.test(error?.message ?? '')
      ? error.message
      : 'PLAN_PREPARATION_FAILED';
    console.error(JSON.stringify({ status: 'BLOCKED', code }));
    process.exitCode = 2;
  });
