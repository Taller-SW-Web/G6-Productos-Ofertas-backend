import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const sha = /^[0-9a-f]{40}$/;
const digest = /^sha256:[0-9a-f]{64}$/;
const hash = /^[0-9a-f]{64}$/;
const repository = 'Taller-SW-Web/G6-Productos-Ofertas-backend';
const imageRoot = 'ghcr.io/taller-sw-web/g6-productos-ofertas-backend/';
const services = new Set([
  'api-gateway',
  'bulk-svc',
  'catalog-svc',
  'combos-svc',
  'inventory-svc',
  'price-audit-svc',
  'pricing-svc',
  'promotions-svc',
  'taxonomy-svc',
]);

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

// This checks a trusted export of deployment evidence. It grants no authorization.
export function evaluateCdEvidence(input) {
  const {
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
    [
      'CD-04',
      environment?.name === 'azure-h5' &&
        environment?.approval_verified === true &&
        environment?.approval_run_id === run_id &&
        environment?.prevent_self_review === true &&
        environment?.admin_bypass === false &&
        Number.isInteger(environment?.reviewers) &&
        environment.reviewers > 0 &&
        Array.isArray(environment?.allowed_branches) &&
        environment.allowed_branches.length === 1 &&
        environment.allowed_branches[0] === 'master',
    ],
    [
      'CD-05',
      oidc?.method === 'oidc' &&
        oidc?.run_id === run_id &&
        oidc?.persistent_credentials === false &&
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
