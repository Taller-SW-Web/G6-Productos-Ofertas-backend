import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { constanciaFirmada } from './evidencia-integracion.mjs';

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
    'G5-H5-05',
    (events) =>
      events.some((e) => e.method === 'POST' && e.status === 202) &&
      events.some((e) => e.event === 'terminal' && e.status === 'COMPLETED'),
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
    'G5-H5-13',
    (events) => events.some((e) => e.event === 'uniform_coupon_not_found'),
  ],
]);

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
    if (fixture.execute === true && stage) {
      const run = spawnSync(process.execPath, [runner, stage, fixture.plan], {
        encoding: 'utf8',
        timeout: 420_000,
      });
      row.evidence = String(run.stdout ?? '')
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const detail = /"code":"([A-Z0-9_]+)"/.exec(
        String(run.stderr ?? ''),
      )?.[1];
      if (run.status !== 0) {
        const blocked =
          /^G5_|^G7_|^REAL_NEGATIVE_G7_|^AUTHORIZED_|^INTEGRATION_MUTATIONS_|^RESERVATION_AND_ORDER_/.test(
            detail ?? '',
          );
        row.status = blocked ? 'BLOCKED' : 'FAIL';
        row.reason = detail ?? 'FALLO_EJECUCION';
        continue;
      }
      if (observations.has(id)) {
        row.status = observations.get(id)(row.evidence) ? 'PASS' : 'FAIL';
        row.reason = 'OBSERVACION_AUTOMATICA';
        continue;
      }
    }
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
        !ids.includes(proof.operation_or_reservation_id) ||
        !Number.isFinite(Date.parse(proof.observed_at)) ||
        Date.parse(proof.observed_at) > Date.now() ||
        !httpsEvidence(proof.evidence_url) ||
        !['PASS', 'FAIL', 'BLOCKED'].includes(proof.status) ||
        (proof.status === 'PASS' && proof.observed !== expected)
      )
        throw new Error();
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
  await writeFile(
    resultPath,
    JSON.stringify({ recorded_at: recordedAt, results }, null, 2) + '\n',
    { flag: 'wx' },
  );
  const counts = Object.fromEntries(
    ['PASS', 'FAIL', 'BLOCKED'].map((status) => [
      status,
      results.filter((r) => r.status === status).length,
    ]),
  );
  console.log(JSON.stringify(counts));
  process.exitCode = counts.FAIL ? 1 : counts.BLOCKED ? 2 : 0;
}

main().catch(() => {
  console.error(
    'No se pudo generar el reporte H5. Revisar argumentos, manifiesto y ruta de salida nueva.',
  );
  process.exitCode = 1;
});
