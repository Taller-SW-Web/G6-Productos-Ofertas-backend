import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { constanciaFirmada } from './evidencia-integracion.mjs';
import { verificarDespliegue } from './verificar-despliegue.mjs';

const scenarios = [
  ['G6', 'reserve', 'Pedido de prueba y saldo disponible', 'RESERVA_COMPLETED'],
  [
    'G5+G6',
    'reserve',
    'Pedido de prueba sin saldo suficiente',
    'RESERVA_REJECTED_SIN_PAGO',
  ],
  [
    'G5+G6',
    'confirm',
    'Pago confirmado por G5, cupón completado y reserva vigente',
    'STOCK_CONFIRMED',
  ],
  [
    'G5+G6',
    'cancel',
    'Pedido anulado por G5 y reserva sin confirmar',
    'RESERVA_LIBERADA',
  ],
  [
    'G5+G6',
    'coupon',
    'Reserva vigente, snapshot y cliente real habilitado por G7',
    'CUPON_202_Y_COMPLETED',
  ],
  [
    'G5+G6',
    'cancel',
    'Consumo previo, anulación firmada y política aplicable',
    'RESTAURACION_TERMINAL',
  ],
  [
    'G6',
    'follow',
    'Pérdida controlada de respuesta con UUID original',
    'INTENCION_UNICA_RECUPERADA',
  ],
  [
    'G6',
    'coupon',
    'Consumo existente y misma identidad con otro contenido',
    'CONFLICTO_409',
  ],
  [
    'G5',
    null,
    'M1 detenido con operación pendiente persistida',
    'M1_RECUPERA_AL_REINICIAR',
  ],
  [
    'G6',
    'expired',
    'Reserva aún ACTIVA después de expires_at',
    'ACTIVA_VENCIDA',
  ],
  [
    'G5+G6',
    'expired',
    'Reserva EXPIRADA entre barridos M1',
    'EXPIRADA_Y_CONCILIADA',
  ],
  [
    'G5+G6',
    null,
    'Pago y anulación concurrentes cerca del vencimiento',
    'UN_ESTADO_COMERCIAL_COHERENTE',
  ],
  [
    'G6',
    'auth',
    'Operación real y dos referencias, una ajena y otra inexistente',
    '404_UNIFORME',
  ],
  [
    'G6+G7',
    'auth',
    'JWT G7 real positivo, expirado, otra audiencia y scope insuficiente',
    'AUTORIZACION_REAL_VERIFICADA',
  ],
  [
    'G6',
    'follow',
    'Worker reiniciado con Outbox pendiente y reserva de prueba',
    'OUTBOX_RECUPERADO_TRAS_REINICIO',
  ],
  [
    'G6',
    'follow',
    'Mismo MessageId entregado dos veces o pérdida del settlement',
    'UN_EFECTO_Y_SETTLEMENT',
  ],
  [
    'G5+G6',
    null,
    'M2 con recepción parcial confirmada y saldo previo',
    'REINTEGRO_UNICO',
  ],
  [
    'G5+G6+G2',
    null,
    'Cambio aprobado, orden de reemplazo y entrega en sandbox',
    'REEMPLAZO_CONSUMIDO_ANTES_DESPACHO',
  ],
  [
    'G5+G6',
    'follow',
    'Corte aprobado, auditoría de pendientes y ruta de vuelta',
    'PENDIENTES_CONCILIADOS',
  ],
  [
    'G6',
    null,
    'Destinatarios obligatorios identificados para cada productor',
    'EFECTOS_VERIFICADOS_POR_DESTINO',
  ],
];
const idOf = (index) => 'G5-H5-' + String(index + 1).padStart(2, '0');
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
  if (stage === 'auth') return plan.operations?.coupon;
  if (stage === 'cancel')
    return plan.operations?.[id === 'G5-H5-04' ? 'release' : 'restore'];
  return plan.operations?.[stage];
}

const executeStage = (stage, plan) =>
  spawnSync(process.execPath, [runner, stage, plan], {
    encoding: 'utf8',
    timeout: 420_000,
  });

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

export async function ejecutarMatriz(
  manifest,
  selected = [],
  execute = executeStage,
  verifyDeployment = verificarDespliegue,
) {
  const recordedAt = new Date().toISOString();
  const results = [];
  for (const [
    index,
    [actor, stage, preconditions, expected],
  ] of scenarios.entries()) {
    const id = idOf(index);
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
      typeof plan.order_id !== 'string' ||
      !plan.order_id.trim()
    ) {
      row.reason = 'AMBIENTE_SHA_O_PEDIDO_INVALIDO';
      continue;
    }
    const ids = [
      plan.reservation_id,
      plan.follow_operation_id,
      ...Object.values(plan.operations ?? {}),
    ].filter((id) => uuid.test(id));
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
      const run = execute(stage, fixture.plan);
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
        stage === 'expired' ? 'reservation_id' : 'operation_id';
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
  const report = await ejecutarMatriz(manifest, selected);
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
