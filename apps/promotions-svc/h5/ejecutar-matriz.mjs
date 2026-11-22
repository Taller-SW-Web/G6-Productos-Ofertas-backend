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

const missingPreconditions = new Set([
  'AUTHORIZED_INTEGRATION_ORIGIN_AND_G6_SHA_REQUIRED',
  'G7_VENTAS_TOKEN_REQUIRED',
  'INTEGRATION_MUTATIONS_NOT_APPROVED',
  'G5_SHA_AND_ORDER_REQUIRED',
  'RESERVATION_AND_ORDER_REQUIRED',
  'REAL_NEGATIVE_G7_TOKENS_REQUIRED',
  'G5_SNAPSHOT_REQUIRED',
  'G5_SIGNED_BUSINESS_EVIDENCE_REQUIRED',
]);

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
    if (bilateral && (fixture.execute === true || fixture.attestation)) {
      try {
        row.deployment = await verifyDeployment(plan);
      } catch {
        row.reason = 'DESPLIEGUE_OFICIAL_NO_VERIFICADO';
        continue;
      }
    }
    let technicalPassed = false;
    if (fixture.execute === true && stage) {
      const run = execute(stage, fixture.plan);
      const detail = /"code":"([A-Z0-9_]+)"/.exec(
        String(run.stderr ?? ''),
      )?.[1];
      if (run.status !== 0) {
        const blocked = !run.error && missingPreconditions.has(detail);
        row.status = blocked ? 'BLOCKED' : 'FAIL';
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
      const observe = observations.get(id);
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
      if (
        !uuid.test(primaryId) ||
        !metadataMatches ||
        !linked.length ||
        (observe && !observe(linked, primaryId))
      ) {
        row.status = 'FAIL';
        row.reason = 'OBSERVACION_AUTOMATICA_FALLIDA';
        continue;
      }
      technicalPassed = true;
      if (observe && !bilateral) {
        row.status = 'PASS';
        row.reason = 'OBSERVACION_AUTOMATICA';
        continue;
      }
    }
    if (bilateral && stage && !technicalPassed) {
      row.reason = 'FALTA_EJECUCION_TECNICA';
      continue;
    }
    if (bilateral) row.reason = 'FALTA_CONSTANCIA_BILATERAL';
    if (!fixture.attestation) continue;
    try {
      const proof = await constanciaFirmada(
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
        (bilateral && stage
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
      if (bilateral && proof.status === 'PASS') {
        if (
          row.deployment.some(
            (entry) =>
              Date.parse(proof.observed_at) < Date.parse(entry.deployed_at),
          )
        )
          throw new Error();
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
      }
      Object.assign(row, {
        status: proof.status,
        reason: 'CONSTANCIA_DE_SESION_VALIDADA',
        observed_at: proof.observed_at,
        observed: proof.observed,
        evidence_url: proof.evidence_url,
        evidence_identifier: proof.operation_or_reservation_id,
      });
    } catch {
      row.reason = 'CONSTANCIA_DE_SESION_INVALIDA';
    }
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
