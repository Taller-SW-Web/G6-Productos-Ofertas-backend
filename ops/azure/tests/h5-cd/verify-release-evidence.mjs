import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const sha = /^[0-9a-f]{40}$/;
const digest = /^sha256:[0-9a-f]{64}$/;
const hash = /^[0-9a-f]{64}$/;
const repository = 'Taller-SW-Web/G6-Productos-Ofertas-backend';
const imageRoot = 'ghcr.io/taller-sw-web/g6-productos-ofertas-backend/';

const targets = JSON.parse(
  readFileSync(
    new URL('../../container-apps/deployment-targets.json', import.meta.url),
    'utf8',
  ),
);
const environmentProtectionScript = readFileSync(
  new URL(
    '../../container-apps/verify-environment-protection.sh',
    import.meta.url,
  ),
  'utf8',
);

const chileDestination = 'chile-shared';
const chileTarget = targets.destinations?.[chileDestination];
if (!chileTarget || chileTarget.githubEnvironment !== 'azure-h5-chile') {
  throw new Error('CHILE_DEPLOYMENT_TARGET_INVALID');
}

const chilePolicyMatch = environmentProtectionScript.match(
  /elif \[\[ "\$environment_name" == azure-h5-chile \]\]; then([\s\S]*?)else/,
);
const chileReviewerIdMatch = chilePolicyMatch?.[1]?.match(
  /\.reviewers\[0\]\.type == "User" and \.reviewers\[0\]\.reviewer\.id == (\d+)/,
);
const chileReviewerLoginMatch = chilePolicyMatch?.[1]?.match(
  /Chile requiere solo a ([a-zA-Z0-9-]+) como reviewer/,
);
if (
  !chilePolicyMatch ||
  !chileReviewerIdMatch ||
  !chileReviewerLoginMatch ||
  !chilePolicyMatch[1].includes('.prevent_self_review == false') ||
  !chilePolicyMatch[1].includes('[[ "$admin_bypass" == false ]]')
) {
  throw new Error('CHILE_ENVIRONMENT_PROTECTION_SOURCE_INVALID');
}

export const CHILE_POLICY = Object.freeze({
  destination: chileDestination,
  github_environment: chileTarget.githubEnvironment,
  aca_environment: chileTarget.acaEnvironment,
  resource_group: chileTarget.resourceGroup,
  subscription_id: targets.subscriptionId,
  reviewer: Object.freeze({
    type: 'User',
    id: Number(chileReviewerIdMatch[1]),
    login: chileReviewerLoginMatch[1],
  }),
  prevent_self_review: false,
  admin_bypass: false,
  allowed_branch: 'master',
  branch_policy_type: 'branch',
});

const services = new Set(targets.services);

function expectedAppResourceId(service) {
  return `/subscriptions/${CHILE_POLICY.subscription_id}/resourceGroups/${CHILE_POLICY.resource_group}/providers/Microsoft.App/containerApps/${service}`;
}

function imageForService(reference, service) {
  const prefix = imageRoot + service + '@';
  return (
    typeof reference === 'string' &&
    reference.startsWith(prefix) &&
    digest.test(reference.slice(prefix.length))
  );
}

function healthMatches(response, service, status) {
  return (
    response?.http_status === 200 &&
    response.body?.service === service &&
    response.body?.status === status
  );
}

function isAuthorizedChileReviewer(reviewer) {
  return (
    reviewer?.type === CHILE_POLICY.reviewer.type &&
    reviewer?.id === CHILE_POLICY.reviewer.id &&
    reviewer?.login === CHILE_POLICY.reviewer.login
  );
}

function isValidChileEnvironment(destination, environment, runId) {
  const reviewers = environment?.reviewers;
  const approvedBy = environment?.approved_by;
  const triggeredBy = environment?.triggered_by;
  const hasValidTrigger =
    triggeredBy === undefined ||
    (typeof triggeredBy === 'object' &&
      triggeredBy !== null &&
      Number.isInteger(triggeredBy.id) &&
      typeof triggeredBy.login === 'string' &&
      triggeredBy.login.length > 0);
  const selfApprovalCoherent =
    environment?.self_approved === undefined ||
    (typeof environment.self_approved === 'boolean' &&
      (!triggeredBy ||
        environment.self_approved === (triggeredBy.id === approvedBy?.id)));

  return (
    destination === CHILE_POLICY.destination &&
    environment?.destination === CHILE_POLICY.destination &&
    environment?.name === CHILE_POLICY.github_environment &&
    environment?.approval_verified === true &&
    environment?.approval_run_id === runId &&
    environment?.prevent_self_review === CHILE_POLICY.prevent_self_review &&
    environment?.admin_bypass === CHILE_POLICY.admin_bypass &&
    Array.isArray(reviewers) &&
    reviewers.length === 1 &&
    isAuthorizedChileReviewer(reviewers[0]) &&
    isAuthorizedChileReviewer(approvedBy) &&
    hasValidTrigger &&
    selfApprovalCoherent &&
    environment?.custom_branch_policies === true &&
    environment?.protected_branches === false &&
    environment?.branch_policy_type === CHILE_POLICY.branch_policy_type &&
    Array.isArray(environment?.allowed_branches) &&
    environment.allowed_branches.length === 1 &&
    environment.allowed_branches[0] === CHILE_POLICY.allowed_branch
  );
}

// This checks a trusted export of Chile deployment evidence. It grants no authorization.
export function evaluateCdEvidence(input) {
  const {
    destination,
    source_sha,
    master_sha,
    repo,
    ref,
    head_verified,
    service,
    image,
    run_id,
    receipt,
    environment,
    oidc,
    audit,
    smoke,
    recovery,
  } = input;
  const vulnerabilities = audit?.report?.metadata?.vulnerabilities;
  const validAudit =
    audit?.source_sha === source_sha &&
    audit?.exit_code === 0 &&
    hash.test(audit?.lock_sha256 ?? '') &&
    hash.test(audit?.report_sha256 ?? '') &&
    !audit?.report?.error &&
    vulnerabilities?.high === 0 &&
    vulnerabilities?.critical === 0;
  const healthy =
    smoke?.run_id === run_id &&
    /^https:\/\/[a-z0-9.-]+\/?$/i.test(smoke?.origin ?? '') &&
    smoke.origin === receipt?.origin &&
    healthMatches(smoke?.liveness, service, 'ok') &&
    (service === 'api-gateway' ||
      healthMatches(smoke?.readiness, service, 'ready')) &&
    [401, 403].includes(smoke?.unauthenticated_status);
  const sameRun = typeof run_id === 'string' && /^\d+$/.test(run_id);
  const boundRevision =
    destination === CHILE_POLICY.destination &&
    receipt?.destination === CHILE_POLICY.destination &&
    receipt?.github_environment === CHILE_POLICY.github_environment &&
    receipt?.aca_environment === CHILE_POLICY.aca_environment &&
    receipt?.app_resource_id === expectedAppResourceId(service) &&
    receipt?.target === image?.reference &&
    receipt?.run_id === run_id &&
    receipt?.source_sha === source_sha &&
    receipt?.service === service &&
    receipt?.served_digest === image?.reference?.split('@')[1] &&
    typeof receipt?.served_revision === 'string' &&
    receipt.served_revision.length > 0 &&
    receipt?.traffic_weight === 100;

  const validRecovery = !recovery
    ? healthy
    : recovery.run_id === run_id &&
      recovery.service === service &&
      recovery.source_sha === source_sha &&
      recovery.supervised === true &&
      recovery.candidate === image?.reference &&
      imageForService(receipt?.previous_image, service) &&
      recovery.restored_image === receipt.previous_image &&
      typeof receipt.previous_revision === 'string' &&
      receipt.previous_revision.length > 0 &&
      recovery.restored_revision === receipt.previous_revision;
  const checks = [
    ['CD-01', sha.test(master_sha ?? '') && source_sha === master_sha],
    [
      'CD-02',
      repo === repository &&
        ref === 'refs/heads/master' &&
        sha.test(source_sha ?? '') &&
        head_verified === true,
    ],
    [
      'CD-03',
      services.has(service) &&
        image?.source_sha === source_sha &&
        imageForService(image?.reference, service) &&
        sameRun &&
        boundRevision,
    ],
    ['CD-04', isValidChileEnvironment(destination, environment, run_id)],
    [
      'CD-05',
      oidc?.method === 'oidc' &&
        oidc?.run_id === run_id &&
        oidc?.persistent_credentials === false &&
        oidc?.federated_environment === CHILE_POLICY.github_environment &&
        oidc?.federated_environment === environment?.name,
    ],
    ['CD-06', validAudit],
    ['CD-07', healthy],
    ['CD-08', validRecovery],
  ].map(([case_id, pass]) => ({
    case_id,
    execution_result: pass ? 'PASS' : 'FAIL',
  }));
  const execution_result = checks.every(
    (check) => check.execution_result === 'PASS',
  )
    ? 'PASS'
    : 'FAIL';
  return {
    case_id: 'SEC-CD-01',
    destination: CHILE_POLICY.destination,
    environment: CHILE_POLICY.github_environment,
    level: 'EVIDENCE_FORMAT',
    execution_result,
    checks,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const result = evaluateCdEvidence(
      JSON.parse(await readFile(process.argv[2], 'utf8')),
    );
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.execution_result === 'PASS' ? 0 : 1;
  } catch {
    console.error('SEC-CD-01: INVALID_INPUT');
    process.exitCode = 1;
  }
}
