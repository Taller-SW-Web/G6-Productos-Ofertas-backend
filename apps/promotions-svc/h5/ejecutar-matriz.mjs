import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { constanciaFirmada } from './evidencia-integracion.mjs';
import { verificarDespliegue } from './verificar-despliegue.mjs';
import { authorizeMutation, loadMutationAuthorization } from './autorizacion-mutaciones.mjs';

const scenarios = JSON.parse(await readFile(resolve(dirname(fileURLToPath(import.meta.url)), 'escenarios.json'), 'utf8'));
const idOf = (index) => scenarios[index].id;
const sha = /^[0-9a-f]{40}$/i;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const runner = fileURLToPath(
  new URL('./ejecutar-integracion.mjs', import.meta.url),
);
const observations = new Map([
  [
    'G5-H5-01',
    (events) =>
      events.some(
        (e) =>
          e.event === 'terminal' &&
          e.status === 'COMPLETED' &&
          uuid.test(e.reservation_id),
      ),
  ],
  [
    'G5-H5-02',
    (events, operation) =>
      events.some(
        (e) =>
          e.operation_id === operation &&
          e.event === 'terminal' &&
          e.status === 'REJECTED',
      ),
  ],
  [
    'G5-H5-05',
    (events, operation) =>
      events.some(
        (e) =>
          e.operation_id === operation &&
          e.method === 'POST' &&
          e.status === 202,
      ) &&
      events.some(
        (e) =>
          e.operation_id === operation &&
          e.event === 'terminal' &&
          e.status === 'COMPLETED',
      ),
  ],
  [
    'G5-H5-08',
    (events) =>
      events.some(
        (e) =>
          e.method === 'POST' &&
          e.status === 409 &&
          e.code === 'IDEMPOTENCY_CONFLICT',
      ),
  ],
  [
    'G5-H5-10',
    (events) =>
      events.some(
        (e) =>
          e.event === 'expiry' &&
          e.estado === 'ACTIVA' &&
          e.vigencia === 'VENCIDA',
      ),
  ],
  [
    'G5-H5-11',
    (events) =>
      events.some((e) => e.event === 'expiry' && e.estado === 'EXPIRADA'),
  ],
  [
    'G5-H5-13',
    (events) => events.some((e) => e.event === 'uniform_coupon_not_found'),
  ],
]);

const supervisedRuntimeCases = new Set(['G5-H5-07', 'G5-H5-15', 'G5-H5-16']);
const terminalStatuses = new Set(['COMPLETED', 'REJECTED']);

function ordered(...timestamps) {
  const times = timestamps.map((timestamp) =>
    typeof timestamp === 'string' ? Date.parse(timestamp) : NaN,
  );
  return times.every(
    (time, index) =>
      Number.isFinite(time) && (index === 0 || time > times[index - 1]),
  );
}

function runtimeEvidenceMatches(id, proof, terminal, afterDeployment) {
  const facts = proof.runtime_evidence;
  if (!facts || !terminal || facts.operation_id !== terminal.operation_id)
    return false;
  if (id === 'G5-H5-07') {
    return (
      terminal.status === 'COMPLETED' &&
      facts.request_operation_id === terminal.operation_id &&
      facts.recovered_operation_id === terminal.operation_id &&
      facts.operation_rows === 1 &&
      facts.effect_count === 1 &&
      ordered(
        afterDeployment,
        facts.response_lost_at,
        facts.recovered_at,
        proof.observed_at,
      )
    );
  }
  if (id === 'G5-H5-15') {
    return (
      uuid.test(facts.message_id) &&
      facts.outbox_pending_message_id === facts.message_id &&
      facts.outbox_recovered_message_id === facts.message_id &&
      typeof facts.worker_before === 'string' &&
      facts.worker_before.trim() !== '' &&
      typeof facts.worker_after === 'string' &&
      facts.worker_after.trim() !== '' &&
      facts.worker_before !== facts.worker_after &&
      Date.parse(facts.terminal_at) === Date.parse(terminal.completed_at) &&
      ordered(
        afterDeployment,
        facts.outbox_pending_at,
        facts.worker_restarted_at,
      ) &&
      ordered(
        afterDeployment,
        facts.worker_stopped_at,
        facts.worker_restarted_at,
        facts.outbox_recovered_at,
        facts.terminal_at,
        proof.observed_at,
      )
    );
  }
  const { deliveries } = facts;
  return (
    terminal.status === 'COMPLETED' &&
    uuid.test(facts.message_id) &&
    facts.inbox_message_id === facts.message_id &&
    facts.inbox_rows === 1 &&
    facts.effect_count === 1 &&
    Array.isArray(deliveries) &&
    deliveries.length >= 2 &&
    deliveries.every(
      (delivery) =>
        delivery?.message_id === facts.message_id &&
        typeof delivery.trace_id === 'string' &&
        /^[A-Za-z0-9_.:-]{1,128}$/.test(delivery.trace_id) &&
        ['COMPLETED', 'LOCK_LOST', 'ABANDONED', 'UNCONFIRMED'].includes(
          delivery.settlement,
        ),
    ) &&
    new Set(deliveries.map((delivery) => delivery.trace_id)).size ===
      deliveries.length &&
    ordered(
      afterDeployment,
      ...deliveries.map((delivery) => delivery.observed_at),
      proof.observed_at,
    ) &&
    deliveries.at(-1).settlement === 'COMPLETED'
  );
}

function stageIdentifier(id, stage, plan) {
  if (stage === 'expired') return plan.reservation_id;
  if (stage === 'follow') return plan.follow_operation_id;
  if (stage === 'auth')
    return id === 'G5-H5-14'
      ? plan.correlation_id
      : plan.auth?.existing_coupon_operation_id;
  if (stage === 'cancel')
    return plan.operations?.[id === 'G5-H5-04' ? 'release' : 'restore'];
  return plan.operations?.[stage];
}

const executeStage = (stage, plan, statePath, authorizationPath) =>
  spawnSync(
    process.execPath,
    [runner, stage, plan, ...(statePath ? [statePath] : []), ...(authorizationPath ? [authorizationPath, 'true'] : [])],
    {
      encoding: 'utf8',
      timeout: 420_000,
    },
  );

function httpsEvidence(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function g5DeploymentVerified(plan) {
  const evidence = plan.g5_deployment;
  if (
    evidence?.verification_status !== 'VERIFIED' ||
    evidence.commit_sha !== plan.g5_sha ||
    !/^sha256:[a-f0-9]{64}$/i.test(evidence.image_digest ?? '') ||
    typeof evidence.revision !== 'string' ||
    !evidence.revision.trim() ||
    !httpsEvidence(evidence.evidence_url) ||
    typeof evidence.verified_by !== 'string' ||
    !evidence.verified_by.trim() ||
    !Number.isFinite(Date.parse(evidence.verified_at))
  )
    return false;
  return true;
}

export async function ejecutarMatriz(
  manifest,
  selected = [],
  execute = executeStage,
  verifyDeployment = verificarDespliegue,
  authorize = authorizeMutation,
  loadAuthorization = loadMutationAuthorization,
) {
  const recordedAt = new Date().toISOString();
  const results = [];
  for (const scenario of scenarios) {
    const { id, actor, stage, preconditions, expected } = scenario;
    const fixture = manifest[id];
    const row = {
      id,
      actor,
      stage,
      preconditions,
      expected,
      status: 'BLOCKED',
      technical_status: 'NOT_RUN',
      reason: 'FALTA_EJECUCION_O_CONSTANCIA',
      recorded_at: recordedAt,
    };
    results.push(row);
    if (selected.length && !selected.includes(id)) continue;
    if (!fixture?.plan) continue;
    let plan;
    try {
      plan = JSON.parse(await readFile(fixture.plan, 'utf8'));
    } catch {
      row.reason = 'PLAN_ILEGIBLE';
      continue;
    }
    if (
      plan?.environment !== 'integration' ||
      !sha.test(plan.g6_sha) ||
      (actor.includes('G5') && !sha.test(plan.g5_sha)) ||
      (id !== 'G5-H5-20' &&
        (typeof plan.order_id !== 'string' || !plan.order_id.trim())) ||
      !g5DeploymentVerified(plan)
    ) {
      row.reason = !g5DeploymentVerified(plan)
        ? 'SHA_G5_SIN_EVIDENCIA_VERIFICADA'
        : 'AMBIENTE_SHA_O_PEDIDO_INVALIDO';
      continue;
    }
    const ids = [...new Set([
      plan.reservation_id,
      plan.follow_operation_id,
      ...(id === 'G5-H5-14' ? [plan.correlation_id] : []),
      ...(id === 'G5-H5-20' ? (plan.message_ids ?? []) : []),
      ...Object.values(plan.operations ?? {}),
    ].filter((id) => uuid.test(id)))];
    Object.assign(row, {
      environment: plan.environment,
      g6_sha: plan.g6_sha,
      g5_sha: plan.g5_sha,
      order_id: plan.order_id,
      identifiers: ids,
    });
    if (!ids.length) continue;
    const bilateral = actor !== 'G6';
    const primaryId = stageIdentifier(id, stage, plan);
    if (stage !== null && fixture.execute !== true) {
      row.reason = 'FALTA_EJECUCION_TECNICA';
      continue;
    }
    if (['reserve', 'coupon', 'confirm', 'cancel'].includes(stage)) {
      try {
        if (typeof fixture.mutation_authorization !== 'string')
          throw new Error('MUTATION_AUTHORIZATION_FILE_REQUIRED');
        const authorization = await loadAuthorization(fixture.mutation_authorization);
        await authorize({ stage, plan, authorization, execute: fixture.execute === true });
      } catch (error) {
        row.reason = /^[A-Z0-9_-]{1,100}$/.test(error?.message ?? '')
          ? error.message
          : 'MUTATION_AUTHORIZATION_INVALID';
        continue;
      }
    }
    if (stage === null && !fixture.attestation) continue;
    try {
      row.deployment = await verifyDeployment(plan);
    } catch {
      row.reason = 'DESPLIEGUE_OFICIAL_NO_VERIFICADO';
      continue;
    }
    let technicalPassed = false;
    let terminal;
    const observe = observations.get(id);
    const needsRuntime = supervisedRuntimeCases.has(id);
    if (stage !== null) {
      const run = execute(stage, fixture.plan, fixture.state, fixture.mutation_authorization);
      row.technical_status = 'FAIL';
      const detail = /"code":"([A-Z0-9_]+)"/.exec(
        String(run.stderr ?? ''),
      )?.[1];
      if (run.status !== 0) {
        row.status = 'FAIL';
        row.reason = detail ?? 'FALLO_EJECUCION';
        continue;
      }
      try {
        row.evidence = String(run.stdout ?? '')
          .trim()
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        if (
          row.evidence.some(
            (event) =>
              !event || typeof event !== 'object' || Array.isArray(event),
          )
        )
          throw new Error();
      } catch {
        row.status = 'FAIL';
        row.reason = 'EVIDENCIA_TECNICA_INVALIDA';
        continue;
      }
      const metadataMatches = row.evidence.every(
        (event) =>
          event.environment === plan.environment &&
          event.g6_sha === plan.g6_sha &&
          event.g5_sha === plan.g5_sha &&
          event.order_id === plan.order_id,
      );
      const identifier =
        stage === 'expired'
          ? 'reservation_id'
          : stage === 'auth' && id === 'G5-H5-14'
            ? 'correlation_id'
            : 'operation_id';
      const linked = row.evidence.filter(
        (event) => event[identifier] === primaryId,
      );
      terminal = linked.find(
        (event) =>
          event.event === 'terminal' && terminalStatuses.has(event.status),
      );
      if (
        !uuid.test(primaryId) ||
        !metadataMatches ||
        !linked.length ||
        (observe && !observe(linked, primaryId)) ||
        (needsRuntime && !terminal)
      ) {
        row.status = 'FAIL';
        row.reason = 'OBSERVACION_AUTOMATICA_FALLIDA';
        continue;
      }
      technicalPassed = true;
      row.technical_status = 'PASS';
    }
    if (stage !== null && !technicalPassed) {
      row.reason = 'FALTA_EJECUCION_TECNICA';
      continue;
    }
    const requiresProof = bilateral || needsRuntime || !observe;
    let proof;
    if (requiresProof) {
      row.reason = needsRuntime
        ? 'FALTA_EVIDENCIA_RUNTIME_SUPERVISADA'
        : bilateral
          ? 'FALTA_CONSTANCIA_BILATERAL'
          : 'FALTA_CONSTANCIA_SUPERVISADA';
      if (!fixture.attestation) continue;
      try {
        proof = await constanciaFirmada(
          fixture.attestation,
          'G5_H5_SESSION_EVIDENCE_PUBLIC_KEY',
          'CONSTANCIA_DE_SESION_INVALIDA',
        );
        if (
          proof?.case_id !== id ||
          proof.actor !== actor ||
          proof.environment !== 'integration' ||
          proof.gateway !== new URL(plan.gateway).origin ||
          proof.g6_sha !== plan.g6_sha ||
          proof.g5_sha !== plan.g5_sha ||
          proof.order_id !== plan.order_id ||
          (stage !== null
            ? !uuid.test(primaryId) ||
              proof.operation_or_reservation_id !== primaryId
            : !ids.includes(proof.operation_or_reservation_id)) ||
          !Number.isFinite(Date.parse(proof.observed_at)) ||
          Date.parse(proof.observed_at) > Date.now() ||
          !httpsEvidence(proof.evidence_url) ||
          !['PASS', 'FAIL', 'BLOCKED'].includes(proof.status) ||
          (proof.status === 'PASS' && proof.observed !== expected)
        )
          throw new Error();
        if (proof.status === 'PASS') {
          if (
            row.deployment.some(
              (entry) =>
                Date.parse(proof.observed_at) < Date.parse(entry.deployed_at),
            )
          )
            throw new Error();
          const afterDeployment = row.deployment.reduce(
            (latest, entry) =>
              Date.parse(entry.deployed_at) > Date.parse(latest)
                ? entry.deployed_at
                : latest,
            row.deployment[0].deployed_at,
          );
          if (
            needsRuntime &&
            !runtimeEvidenceMatches(id, proof, terminal, afterDeployment)
          ) {
            row.reason = 'EVIDENCIA_RUNTIME_INSUFICIENTE';
            continue;
          }
        }
        Object.assign(row, {
          observed_at: proof.observed_at,
          observed: proof.observed,
          evidence_url: proof.evidence_url,
          evidence_identifier: proof.operation_or_reservation_id,
        });
      } catch {
        row.reason = 'CONSTANCIA_DE_SESION_INVALIDA';
        continue;
      }
    }
    if (proof && proof.status !== 'PASS') {
      row.status = proof.status;
      row.reason = 'CONSTANCIA_DE_SESION_VALIDADA';
      continue;
    }
    if (technicalPassed) {
      try {
        const current = await verifyDeployment(plan);
        if (JSON.stringify(current) !== JSON.stringify(row.deployment))
          throw new Error();
      } catch {
        row.reason = 'DESPLIEGUE_OFICIAL_CAMBIO_O_NO_VERIFICADO';
        continue;
      }
    }
    row.status = 'PASS';
    row.reason = proof
      ? 'CONSTANCIA_DE_SESION_VALIDADA'
      : 'OBSERVACION_AUTOMATICA';
  }
  return { recorded_at: recordedAt, results };
}

async function main() {
  const [manifestPath, resultPath, ...selected] = process.argv.slice(2);
  if (
    !manifestPath ||
    !resultPath ||
    selected.some((id) => !scenarios.some((_, i) => idOf(i) === id))
  )
    throw new Error(
      'Uso: ejecutar-matriz.mjs <manifest.json> <resultado.json> [G5-H5-NN ...]',
    );
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const manifestDirectory = dirname(resolve(manifestPath));
  const resolvedManifest = Object.fromEntries(
    Object.entries(manifest).map(([id, fixture]) => [
      id,
      fixture?.plan
        ? {
            ...fixture,
            plan: resolve(manifestDirectory, fixture.plan),
            ...(typeof fixture.mutation_authorization === 'string'
              ? { mutation_authorization: resolve(manifestDirectory, fixture.mutation_authorization) }
              : {}),
            ...(fixture.state
              ? { state: resolve(manifestDirectory, fixture.state) }
              : {}),
          }
        : fixture,
    ]),
  );
  const report = await ejecutarMatriz(resolvedManifest, selected);
  await writeFile(resultPath, JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
  });
  const counts = Object.fromEntries(
    ['PASS', 'FAIL', 'BLOCKED'].map((status) => [
      status,
      report.results.filter((r) => r.status === status).length,
    ]),
  );
  console.log(JSON.stringify(counts));
  process.exitCode = counts.FAIL ? 1 : counts.BLOCKED ? 2 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error(
      'No se pudo generar el reporte H5. Revisar argumentos, manifiesto y ruta de salida nueva.',
    );
    process.exitCode = 1;
  });
