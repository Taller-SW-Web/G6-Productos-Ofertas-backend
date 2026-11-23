import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const sha = /^[a-f0-9]{40}$/i;
const digest = /^sha256:[a-f0-9]{64}$/i;
const cdServices = ['api-gateway', 'catalog-svc', 'inventory-svc', 'promotions-svc'];
const fail = (code) => { throw new Error(code); };
const requiredString = (value, code) => {
  if (typeof value !== 'string' || !value.trim() || value.startsWith('<')) fail(code);
  return value;
};
function validateG5Deployment(profile) {
  const evidence = profile.g5_deployment;
  if (!evidence || evidence.verification_status !== 'VERIFIED' ||
      evidence.commit_sha !== profile.g5_sha || !digest.test(evidence.image_digest) ||
      !requiredString(evidence.revision, 'G5_DEPLOYMENT_REVISION_REQUIRED') ||
      !requiredString(evidence.verified_by, 'G5_DEPLOYMENT_VERIFIER_REQUIRED') ||
      !Number.isFinite(Date.parse(evidence.verified_at))) fail('G5_DEPLOYMENT_EVIDENCE_REQUIRED');
  let url;
  try { url = new URL(evidence.evidence_url); } catch { fail('G5_DEPLOYMENT_EVIDENCE_REQUIRED'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    fail('G5_DEPLOYMENT_EVIDENCE_REQUIRED');
}
function validateG5Signature(evidence, scenario, input, profile) {
  if (!evidence || typeof evidence.payload !== 'string' || typeof evidence.signature !== 'string' ||
      !/^[A-Za-z0-9_-]+$/.test(evidence.payload) || !/^[A-Za-z0-9_-]+$/.test(evidence.signature))
    fail(`SIGNED_G5_EVIDENCE_REQUIRED_${scenario.id}`);
  let payload;
  try { payload = JSON.parse(Buffer.from(evidence.payload, 'base64url').toString('utf8')); }
  catch { fail(`SIGNED_G5_EVIDENCE_INVALID_${scenario.id}`); }
  const expectedEvent = scenario.id === 'G5-H5-03' ? 'PAGO_CONFIRMADO' : 'ANULACION_CONFIRMADA';
  const expectedCouponOperation = scenario.id === 'G5-H5-04' ? null : input.operations?.coupon;
  if (payload.issuer !== 'G5' || payload.event !== expectedEvent || payload.environment !== 'integration' ||
      payload.order_id !== input.order_id || payload.g5_sha !== profile.g5_sha ||
      payload.g6_sha !== profile.g6_sha || payload.reservation_id !== input.reservation_id ||
      payload.coupon_operation_id !== expectedCouponOperation ||
      !Number.isFinite(Date.parse(payload.occurred_at)) ||
      payload.gateway !== new URL(profile.gateway).origin)
    fail(`SIGNED_G5_EVIDENCE_MISMATCH_${scenario.id}`);
}
function validateProfile(profile, scenarios) {
  if (profile.environment !== 'integration' || !sha.test(profile.g6_sha) || !sha.test(profile.g5_sha))
    fail('INTEGRATION_SHAS_REQUIRED');
  let gateway;
  try { gateway = new URL(profile.gateway); } catch { fail('AUTHORIZED_PRIVATE_GATEWAY_REQUIRED'); }
  if (gateway.protocol !== 'https:' || gateway.username || gateway.password || gateway.search || gateway.hash ||
      profile.gateway !== gateway.origin && profile.gateway !== `${gateway.origin}/`)
    fail('AUTHORIZED_PRIVATE_GATEWAY_REQUIRED');
  for (const service of cdServices)
    if (!/^[1-9][0-9]{0,15}$/.test(String(profile.g6_cd_runs?.[service]))) fail('FOUR_G6_CD_RUNS_REQUIRED');
  if (new Set(cdServices.map((service) => String(profile.g6_cd_runs[service]))).size !== cdServices.length)
    fail('FOUR_DISTINCT_G6_CD_RUNS_REQUIRED');
  validateG5Deployment(profile);
  if (!profile.cases || typeof profile.cases !== 'object') fail('AUTHORIZED_CASE_FIXTURES_REQUIRED');
  for (const scenario of scenarios) {
    const input = profile.cases[scenario.id];
    if (!input || typeof input !== 'object') fail(`CASE_FIXTURE_REQUIRED_${scenario.id}`);
    if (scenario.requires_order) requiredString(input.order_id, `G5_SYNTHETIC_ORDER_REQUIRED_${scenario.id}`);
    if (scenario.requires_order && scenario.id === 'G5-H5-13') {
      requiredString(input.foreign_order_id, 'FOREIGN_ORDER_REQUIRED_G5_H5_13');
      if (input.foreign_order_id === input.order_id) fail('FOREIGN_ORDER_MUST_DIFFER');
    }
    if (scenario.requires_scenario) {
      const commercial = input.scenario;
      if (!commercial || typeof commercial.sku !== 'string' || !commercial.sku.trim() ||
          !Number.isSafeInteger(commercial.quantity) || commercial.quantity < 1 ||
          typeof commercial.channel_id !== 'string' || !commercial.channel_id.trim() ||
          typeof commercial.coupon_code !== 'string' || !commercial.coupon_code.trim() ||
          typeof commercial.currency !== 'string' || !commercial.currency.trim() ||
          (commercial.expected_regular_price !== undefined &&
            (typeof commercial.expected_regular_price !== 'string' ||
             !/^\d+(?:\.\d{1,6})?$/.test(commercial.expected_regular_price) ||
             Number(commercial.expected_regular_price) <= 0)) ||
          !uuid.test(commercial.location_id ?? '') || !uuid.test(input.customer_ref ?? ''))
        fail(`AUTHORIZED_COMMERCIAL_FIXTURE_REQUIRED_${scenario.id}`);
    }
    if (scenario.requires_snapshot &&
        (input.g5_snapshot_confirmed !== true || !uuid.test(input.customer_ref ?? '') ||
         !Number.isFinite(Date.parse(input.effective_at)))) fail(`CONFIRMED_G5_SNAPSHOT_REQUIRED_${scenario.id}`);
    if (scenario.requires_existing_coupon && !uuid.test(input.operations?.coupon ?? ''))
      fail(`EXISTING_COUPON_OPERATION_REQUIRED_${scenario.id}`);
    if (scenario.requires_follow_operation &&
        (!uuid.test(input.follow_operation_id ?? '') || !['cupones', 'inventario'].includes(input.follow_type)))
      fail(`EXISTING_FOLLOW_OPERATION_REQUIRED_${scenario.id}`);
    if (scenario.requires_g5_signature) validateG5Signature(input.g5_evidence, scenario, input, profile);
    if (scenario.id === 'G5-H5-06')
      requiredString(input.expected_restore_outcome, 'RESTORE_OUTCOME_REQUIRED_G5_H5_06');
    if ([scenario.id].includes('G5-H5-10') || scenario.id === 'G5-H5-11' ||
        ['G5-H5-03','G5-H5-04','G5-H5-05','G5-H5-06'].includes(scenario.id))
      if (!uuid.test(input.reservation_id ?? '')) fail(`RESERVATION_REQUIRED_${scenario.id}`);
  }
  const orders = scenarios.filter((item) => item.requires_order).map((item) => profile.cases[item.id].order_id);
  if (new Set(orders).size !== orders.length) fail('EACH_SCENARIO_REQUIRES_AN_ISOLATED_ORDER');
}

export async function prepararPlanes(profile, outputDir, scenarioFile) {
  const scenarios = JSON.parse(await readFile(scenarioFile, 'utf8'));
  validateProfile(profile, scenarios);
  const root = resolve(outputDir);
  const manifest = {};
  const planFiles = [];
  const seenOrders = new Set();
  const seenReservations = new Set();
  const seenOperations = new Set();
  const seenCorrelations = new Set();
  for (const scenario of scenarios) {
    const input = profile.cases[scenario.id];
    if (scenario.requires_order) {
      if (seenOrders.has(input.order_id)) fail('EACH_SCENARIO_REQUIRES_AN_ISOLATED_ORDER');
      seenOrders.add(input.order_id);
    }
    if (input.reservation_id) {
      if (seenReservations.has(input.reservation_id)) fail('RESERVATION_UUID_REUSED_ACROSS_SCENARIOS');
      seenReservations.add(input.reservation_id);
    }
    const operations = Object.fromEntries(
      ['reserve', 'coupon', 'confirm', 'restore', 'release'].map((name) => [
        name,
        input.operations?.[name] ?? randomUUID(),
      ]),
    );
    if (scenario.requires_follow_operation) {
      const operationName = input.follow_type === 'inventario' ? 'reserve' : 'coupon';
      if (input.operations?.[operationName] && input.operations[operationName] !== input.follow_operation_id)
        fail(`FOLLOW_OPERATION_MISMATCH_${scenario.id}`);
      operations[operationName] = input.follow_operation_id;
    }
    for (const [name, id] of Object.entries(operations))
      if (!uuid.test(id)) fail(`INVALID_OPERATION_ID_${scenario.id}_${name.toUpperCase()}`);
    if (new Set(Object.values(operations)).size !== Object.keys(operations).length)
      fail(`OPERATION_UUID_REUSED_WITHIN_SCENARIO_${scenario.id}`);
    for (const id of Object.values(operations)) {
      if (seenOperations.has(id)) fail('OPERATION_UUID_REUSED_ACROSS_SCENARIOS');
      seenOperations.add(id);
    }
    const correlationId = input.correlation_id ?? randomUUID();
    if (!uuid.test(correlationId) || seenCorrelations.has(correlationId))
      fail(`CORRELATION_UUID_INVALID_OR_REUSED_${scenario.id}`);
    seenCorrelations.add(correlationId);
    const plan = {
      environment: profile.environment,
      gateway: profile.gateway,
      g6_sha: profile.g6_sha,
      g6_cd_runs: profile.g6_cd_runs,
      g5_sha: profile.g5_sha,
      g5_deployment: profile.g5_deployment,
      ...(scenario.requires_order ? { order_id: input.order_id } : {}),
      correlation_id: correlationId,
      ...(input.scenario ? { scenario: input.scenario } : {}),
      ...(input.customer_ref ? { customer_ref: input.customer_ref } : {}),
      ...(input.effective_at ? { effective_at: input.effective_at } : {}),
      ...(input.reservation_id ? { reservation_id: input.reservation_id } : {}),
      ...(input.g5_snapshot_confirmed === true ? { g5_snapshot_confirmed: true } : {}),
      ...(input.expected_reserve_status ? { expected_reserve_status: input.expected_reserve_status } : {}),
      ...(scenario.id === 'G5-H5-02' ? { expected_reserve_status: input.expected_reserve_status ?? 'REJECTED' } : {}),
      ...(input.expected_restore_outcome ? { expected_restore_outcome: input.expected_restore_outcome } : {}),
      ...(input.g5_evidence ? { g5_evidence: input.g5_evidence } : {}),
      operations,
      ...(scenario.requires_follow_operation ? {
        follow_type: input.follow_type,
        follow_operation_id: input.follow_operation_id,
      } : {}),
      ...(scenario.id === 'G5-H5-13' ? {
        auth: { existing_coupon_operation_id: operations.coupon, foreign_order_id: input.foreign_order_id },
      } : {}),
      ...(scenario.id === 'G5-H5-04' ? { cancel_mode: 'reject-unbacked-restore' } : {}),
      ...(scenario.id === 'G5-H5-06' ? { cancel_mode: 'restore-consumption' } : {}),
      case_id: scenario.id,
      fixture_origin: input.fixture_origin ?? 'authorized-synthetic-integration',
      execute: false,
    };
    const planName = `${scenario.id}.json`;
    const stateName = `${scenario.id}.runtime.json`;
    planFiles.push([planName, plan]);
    manifest[scenario.id] = { plan: planName, state: stateName, execute: false };
  }
  await mkdir(root, { recursive: false });
  for (const [name, plan] of planFiles)
    await writeFile(resolve(root, name), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
  await writeFile(resolve(root, 'manifiesto.azure.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return { outputDir: root, cases: scenarios.length, manifest: resolve(root, 'manifiesto.azure.json') };
}

async function main() {
  const [profilePath, outputDir] = process.argv.slice(2);
  if (!profilePath || !outputDir) fail('USO: preparar-planes.mjs perfil-autorizado.json directorio-nuevo');
  const profile = JSON.parse(await readFile(profilePath, 'utf8'));
  const result = await prepararPlanes(profile, outputDir, resolve(here, 'escenarios.json'));
  console.log(JSON.stringify({ status: 'PREPARED', ...result }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    const code = /^[A-Z0-9_-]{1,100}$/.test(error?.message ?? '') ? error.message : 'PLAN_PREPARATION_FAILED';
    console.error(JSON.stringify({ status: 'BLOCKED', code }));
    process.exitCode = 2;
  });
