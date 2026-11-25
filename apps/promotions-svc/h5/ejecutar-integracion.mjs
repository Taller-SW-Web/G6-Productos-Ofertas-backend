import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { constanciaComercial } from './evidencia-integracion.mjs';
import {
  authorizeMutation,
  readMutationAuthorization,
} from './autorizacion-mutaciones.mjs';
import { verificarDespliegue } from './verificar-despliegue.mjs';
import { pathToFileURL } from 'node:url';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const sha = /^[a-f0-9]{40}$/i;
const actions = [
  'preflight',
  'reserve',
  'coupon',
  'confirm',
  'cancel',
  'expired',
  'auth',
  'follow',
];
const ensure = (condition, code) => {
  if (!condition) throw new Error(code);
};
const segment = encodeURIComponent;
const orderQuery = (order) => '?' + new URLSearchParams({ order_id: order });

export function cancellationSteps(plan) {
  if (plan.cancel_mode === 'release-only') return ['release'];
  if (
    plan.cancel_mode === 'restore-consumption' ||
    plan.cancel_mode === 'reject-unbacked-restore'
  )
    return ['restore', 'release'];
  throw new Error('CANCEL_MODE_REQUIRED');
}

export async function executeCancellation(
  plan,
  cancellation,
  submit,
  operationId,
  reservationPath,
) {
  for (const step of cancellationSteps(plan)) {
    if (step === 'restore') {
      const restore = {
        order_id: plan.order_id,
        operation_id: operationId('restore'),
        consumption_operation_id: operationId('coupon'),
        cancellation_reason: 'ANULACION',
        cancelled_at: cancellation.occurred_at,
      };
      const restored = await submit(
        'cupones',
        '/cupones/restauraciones',
        restore,
      );
      if (plan.cancel_mode === 'reject-unbacked-restore')
        ensure(
          restored.status === 'REJECTED' &&
            restored.result?.result_code === 'COUPON_IDENTITY_MISMATCH',
          'UNBACKED_RESTORE_WAS_NOT_REJECTED',
        );
      else
        ensure(
          restored.status === 'COMPLETED' &&
            restored.result?.outcome === plan.expected_restore_outcome,
          'RESTORE_RESULT_DIFFERED',
        );
      continue;
    }
    const released = await submit(
      'inventario',
      reservationPath() + '/liberar',
      {
        order_id: plan.order_id,
        operation_id: operationId('release'),
        reason: 'ANULACION',
      },
    );
    ensure(released.status === 'COMPLETED', 'RELEASE_RESULT_DIFFERED');
  }
}

async function main() {
  const [
    action,
    planPath,
    statePath = `${planPath}.runtime.json`,
    authorizationPath,
    executeFlag,
  ] = process.argv.slice(2);
  ensure(actions.includes(action) && planPath, 'USE_ACTION_AND_PLAN_FILE');
  ensure(
    resolve(statePath) !== resolve(planPath),
    'RUNTIME_STATE_PATH_MUST_DIFFER',
  );
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  if (['reserve', 'coupon', 'confirm', 'cancel'].includes(action)) {
    const authorization = await readMutationAuthorization(authorizationPath);
    await authorizeMutation({
      stage: action,
      plan,
      authorization,
      execute: executeFlag === 'true',
    });
    const deployment = await verificarDespliegue(plan);
    ensure(
      deployment.every((service) => service.certification_status === 'SUCCESS'),
      'CD_CERTIFICATION_BLOCKED',
    );
  }
  const runtimeState = await readFile(statePath, 'utf8')
    .then((text) => JSON.parse(text))
    .catch((error) => {
      if (error.code === 'ENOENT') return {};
      throw error;
    });
  const runtimeReservation = runtimeState.reservation_id;
  if (runtimeReservation)
    ensure(
      runtimeState.environment === plan.environment &&
        runtimeState.g6_sha === plan.g6_sha &&
        runtimeState.order_id === plan.order_id &&
        runtimeState.operation_id === plan.operations?.reserve &&
        uuid.test(runtimeReservation) &&
        (!plan.reservation_id || plan.reservation_id === runtimeReservation),
      'RUNTIME_STATE_CONFLICT',
    );
  const gateway = new URL(plan.gateway);
  ensure(
    plan.environment === 'integration' &&
      process.env.G5_H5_AUTHORIZED_GATEWAY_ORIGIN === gateway.origin &&
      gateway.protocol === 'https:' &&
      (plan.gateway === gateway.origin ||
        plan.gateway === gateway.origin + '/') &&
      sha.test(plan.g6_sha),
    'AUTHORIZED_INTEGRATION_ORIGIN_AND_G6_SHA_REQUIRED',
  );
  const token = process.env.G5_H5_VENTAS_JWT;
  ensure(token && !/\s/.test(token), 'G7_VENTAS_TOKEN_REQUIRED');
  const pricingToken =
    action === 'preflight' ? process.env.G5_H5_PRICING_READ_JWT : undefined;
  const couponValidationToken =
    action === 'preflight'
      ? process.env.G5_H5_COUPON_VALIDATION_JWT
      : undefined;
  if (action === 'preflight') {
    ensure(
      pricingToken && !/\s/.test(pricingToken),
      'G7_PRICING_READ_TOKEN_REQUIRED',
    );
    ensure(
      couponValidationToken && !/\s/.test(couponValidationToken),
      'G7_COUPON_VALIDATION_TOKEN_REQUIRED',
    );
  }
  const mutates = ['reserve', 'coupon', 'confirm', 'cancel'].includes(action);
  if (mutates) {
    ensure(
      sha.test(plan.g5_sha) &&
        typeof plan.order_id === 'string' &&
        plan.order_id.trim(),
      'G5_SHA_AND_ORDER_REQUIRED',
    );
  }
  const scenario = plan.scenario;
  if (['preflight', 'reserve', 'coupon'].includes(action))
    ensure(
      scenario &&
        typeof scenario.sku === 'string' &&
        scenario.sku.trim() &&
        Number.isSafeInteger(scenario.quantity) &&
        scenario.quantity > 0 &&
        typeof scenario.channel_id === 'string' &&
        scenario.channel_id.trim() &&
        typeof scenario.coupon_code === 'string' &&
        scenario.coupon_code.trim() &&
        typeof scenario.currency === 'string' &&
        scenario.currency.trim() &&
        (scenario.expected_regular_price === undefined ||
          (typeof scenario.expected_regular_price === 'string' &&
            /^\d+(?:\.\d{1,6})?$/.test(scenario.expected_regular_price) &&
            Number(scenario.expected_regular_price) > 0)),
      'AUTHORIZED_SCENARIO_CONFIGURATION_REQUIRED',
    );
  const location = scenario?.location_id;
  if (['preflight', 'reserve'].includes(action))
    ensure(uuid.test(location), 'LOCATION_REQUIRED');
  const correlationId = plan.correlation_id;
  ensure(uuid.test(correlationId), 'CORRELATION_ID_REQUIRED');
  const order = plan.order_id;
  const base = {
    environment: plan.environment,
    case_id: plan.case_id,
    g6_sha: plan.g6_sha,
    g5_sha: plan.g5_sha,
    action,
    order_id: order,
    correlation_id: correlationId,
  };
  const report = (event) => console.log(JSON.stringify({ ...base, ...event }));

  async function http(method, path, { body, bearer = token } = {}) {
    const headers = {
      Accept: 'application/json',
      'X-Correlation-Id': correlationId,
    };
    if (bearer) headers.Authorization = 'Bearer ' + bearer;
    if (body) {
      headers['Content-Type'] = 'application/json';
      if (body.operation_id) headers['Idempotency-Key'] = body.operation_id;
    }
    const response = await fetch(new URL('/api/v1' + path, gateway), {
      method,
      headers,
      ...(method === 'POST' && body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    }).catch(() => {
      throw new Error('GATEWAY_RESPONSE_UNAVAILABLE');
    });
    const data = await response.json().catch(() => null);
    const code =
      typeof data?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(data.code)
        ? data.code
        : undefined;
    const route = path.split('?')[0];
    const check =
      method === 'GET' && route === '/inventario/disponibilidad'
        ? 'availability'
        : method === 'GET' &&
            route === '/precios/skus/' + segment(scenario?.sku ?? '')
          ? 'price'
          : method === 'POST' && route === '/cupones/validar'
            ? 'coupon'
            : undefined;
    const query = Object.fromEntries(
      new URLSearchParams(path.split('?')[1] ?? ''),
    );
    const requestEvidence =
      method === 'GET'
        ? query
        : body
          ? {
              channel_id: body.channel_id,
              coupon_code: body.coupon_code,
              lines: body.lines,
            }
          : {};
    report({
      event: 'http',
      method,
      route,
      status: response.status,
      code,
      check,
      request: requestEvidence,
      case_id: plan.case_id,
      scenario: scenario
        ? {
            sku: scenario.sku,
            quantity: scenario.quantity,
            channel_id: scenario.channel_id,
            coupon_code: scenario.coupon_code,
            currency: scenario.currency,
            location_id: location,
          }
        : undefined,
      operation_id: body?.operation_id,
    });
    return { status: response.status, data };
  }

  async function expectStatus(method, path, statuses, options) {
    const response = await http(method, path, options);
    ensure(
      statuses.includes(response.status),
      `UNEXPECTED_HTTP_${response.status}`,
    );
    return response.data;
  }

  const operationId = (step) => {
    const id = plan.operations?.[step];
    ensure(uuid.test(id), `OPERATION_ID_REQUIRED_${step.toUpperCase()}`);
    return id;
  };
  const statusPath = (type, id, orderId = order) =>
    type === 'cupones'
      ? '/cupones/operaciones/' + id + orderQuery(orderId)
      : '/inventario/operaciones/' + id;
  const reservationPath = () => {
    ensure(
      uuid.test(plan.reservation_id) &&
        typeof order === 'string' &&
        order.trim(),
      'RESERVATION_AND_ORDER_REQUIRED',
    );
    return '/inventario/reservas/' + segment(plan.reservation_id);
  };

  async function follow(type, id) {
    const until = Date.now() + 120_000;
    while (Date.now() < until) {
      const { status, data } = await http('GET', statusPath(type, id)).catch(
        (error) => {
          if (error.message !== 'GATEWAY_RESPONSE_UNAVAILABLE') throw error;
          return { status: 503 };
        },
      );
      if (status === 200) {
        ensure(
          data?.operation_id === id && data.order_id === order,
          'OPERATION_IDENTITY_MISMATCH',
        );
        if (
          ['COMPLETED', 'REJECTED', 'REQUIRES_REVIEW'].includes(data.status)
        ) {
          report({
            event: 'terminal',
            operation_id: id,
            status: data.status,
            completed_at: data.completed_at,
            reservation_id: data.reservation_id,
            expires_at: data.expires_at,
          });
          return data;
        }
        ensure(
          ['ACCEPTED', 'PROCESSING'].includes(data.status),
          'INVALID_OPERATION_STATE',
        );
      } else ensure([404, 503].includes(status), `UNEXPECTED_HTTP_${status}`);
      await sleep(2000 + Math.floor(Math.random() * 500));
    }
    throw new Error('TERMINAL_TIMEOUT_REUSE_OPERATION_ID');
  }

  async function submit(type, path, body) {
    try {
      await expectStatus('POST', path, [200, 202], { body });
    } catch (error) {
      if (
        error.message !== 'GATEWAY_RESPONSE_UNAVAILABLE' &&
        error.message !== 'UNEXPECTED_HTTP_503'
      )
        throw error;
      const prior = await http('GET', statusPath(type, body.operation_id));
      if (prior.status === 404)
        await expectStatus('POST', path, [200, 202], { body });
      else
        ensure(prior.status === 200, 'ADMISSION_UNCERTAIN_REUSE_OPERATION_ID');
    }
    return follow(type, body.operation_id);
  }

  async function inventoryAvailability() {
    const stock = await expectStatus(
      'GET',
      '/inventario/disponibilidad?' +
        new URLSearchParams({
          skus: scenario.sku,
          location_id: location,
        }),
      [200],
    );
    const item = stock?.items?.find(
      (line) => line.sku === scenario.sku && line.location_id === location,
    );
    ensure(
      item && item.available >= scenario.quantity,
      'INTEGRATION_STOCK_NOT_AVAILABLE',
    );
    return item.available;
  }

  if (action === 'preflight') {
    const available = await inventoryAvailability();
    const pricing = await expectStatus(
      'GET',
      '/precios/skus/' +
        segment(scenario.sku) +
        '?canal=' +
        segment(scenario.channel_id),
      [200],
      { bearer: pricingToken },
    );
    ensure(
      pricing?.sku === scenario.sku &&
        pricing.currency === scenario.currency &&
        Number(pricing.precio_regular) > 0 &&
        (scenario.expected_regular_price === undefined ||
          Number(pricing.precio_regular) ===
            Number(scenario.expected_regular_price)),
      'INTEGRATION_PRICE_INVALID',
    );
    ensure(uuid.test(plan.customer_ref), 'TEST_CUSTOMER_REQUIRED');
    const coupon = await expectStatus('POST', '/cupones/validar', [200], {
      bearer: couponValidationToken,
      body: {
        channel_id: scenario.channel_id,
        customer_ref: plan.customer_ref,
        lines: [{ sku: scenario.sku, quantity: scenario.quantity }],
        coupon_code: scenario.coupon_code,
      },
    });
    ensure(coupon?.valid === true, 'INTEGRATION_COUPON_NOT_ELIGIBLE');
    ensure(
      coupon.currency === scenario.currency &&
        Number(coupon.discount_amount) > 0,
      'INTEGRATION_DISCOUNT_INVALID',
    );
    report({
      event: 'read_only_preflight',
      available,
      price: pricing.precio_regular,
      discount: coupon.discount_amount,
      sku: scenario.sku,
      currency: scenario.currency,
      eligible: coupon.valid,
      price_sku: pricing.sku,
      price_currency: pricing.currency,
      discount_currency: coupon.currency,
    });
    return;
  }

  if (action === 'reserve') {
    const available = await inventoryAvailability();
    const quantity =
      plan.expected_reserve_status === 'REJECTED'
        ? available + 1
        : scenario.quantity;
    const result = await submit('inventario', '/inventario/reservas', {
      order_id: order,
      operation_id: operationId('reserve'),
      channel_id: scenario.channel_id,
      lines: [{ sku: scenario.sku, quantity, location_id: location }],
    });
    ensure(
      result.status === (plan.expected_reserve_status ?? 'COMPLETED'),
      'UNEXPECTED_RESERVATION_RESULT',
    );
    if (result.status === 'COMPLETED')
      ensure(
        uuid.test(result.reservation_id) &&
          Date.parse(result.expires_at) > Date.now(),
        'RESERVATION_NOT_CURRENT',
      );
    if (result.status === 'COMPLETED') {
      ensure(
        !plan.reservation_id || plan.reservation_id === result.reservation_id,
        'RESERVATION_ID_CHANGED_ON_REPLAY',
      );
      const checkpoint = {
        environment: plan.environment,
        g6_sha: plan.g6_sha,
        order_id: order,
        operation_id: operationId('reserve'),
        reservation_id: result.reservation_id,
      };
      const prior = await readFile(statePath, 'utf8')
        .then((text) => JSON.parse(text))
        .catch((error) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        });
      if (prior && JSON.stringify(prior) !== JSON.stringify(checkpoint))
        ensure(
          prior.environment === checkpoint.environment &&
            prior.g6_sha === checkpoint.g6_sha &&
            prior.order_id === checkpoint.order_id &&
            prior.operation_id === checkpoint.operation_id &&
            prior.reservation_id === checkpoint.reservation_id,
          'RUNTIME_STATE_CONFLICT',
        );
      else if (!prior)
        await writeFile(statePath, JSON.stringify(checkpoint, null, 2) + '\n', {
          flag: 'wx',
        });
    }
    return;
  }

  if (action === 'follow') {
    ensure(
      order &&
        uuid.test(plan.follow_operation_id) &&
        ['cupones', 'inventario'].includes(plan.follow_type),
      'FOLLOW_REFERENCE_REQUIRED',
    );
    await follow(plan.follow_type, plan.follow_operation_id);
    return;
  }

  if (action === 'auth') {
    const invalid = '/cupones/consumos';
    await expectStatus('POST', invalid, [400], { body: {} });
    for (const bearer of [
      null,
      process.env.G5_H5_EXPIRED_JWT,
      process.env.G5_H5_WRONG_AUDIENCE_JWT,
    ]) {
      ensure(bearer !== undefined, 'REAL_NEGATIVE_G7_TOKENS_REQUIRED');
      await expectStatus('POST', invalid, [401], { body: {}, bearer });
    }
    const bearer = process.env.G5_H5_WRONG_SCOPE_JWT;
    ensure(bearer, 'REAL_NEGATIVE_G7_TOKENS_REQUIRED');
    await expectStatus('POST', invalid, [403], { body: {}, bearer });
    if (plan.auth?.existing_coupon_operation_id && order) {
      const operation = plan.auth.existing_coupon_operation_id;
      ensure(uuid.test(operation), 'AUTH_EXISTING_OPERATION_REQUIRED');
      const original = await expectStatus(
        'GET',
        statusPath('cupones', operation),
        [200],
      );
      ensure(
        original?.operation_id === operation && original.order_id === order,
        'OPERATION_IDENTITY_MISMATCH',
      );
      const foreignOrder = plan.auth.foreign_order_id;
      ensure(
        typeof foreignOrder === 'string' &&
          foreignOrder.trim() &&
          foreignOrder !== order,
        'FOREIGN_ORDER_REQUIRED',
      );
      const foreign = await expectStatus(
        'GET',
        statusPath('cupones', operation, foreignOrder),
        [404],
      );
      const missing = await expectStatus(
        'GET',
        statusPath('cupones', randomUUID()),
        [404],
      );
      ensure(
        foreign?.code === 'OPERACION_CUPON_NO_ENCONTRADA' &&
          missing?.code === foreign.code &&
          missing.title === foreign.title,
        'COUPON_NOT_FOUND_RESPONSES_DIFFER',
      );
      report({
        event: 'uniform_coupon_not_found',
        operation_id: operation,
      });
    }
    return;
  }

  const reservation = runtimeReservation
    ? '/inventario/reservas/' + segment(runtimeReservation)
    : reservationPath();
  const state = async () =>
    expectStatus('GET', reservation + '/estado' + orderQuery(order), [200]);
  if (action === 'expired') {
    const result = await state();
    ensure(
      result?.order_id === order &&
        result.reservation_id === (runtimeReservation ?? plan.reservation_id),
      'RESERVATION_IDENTITY_MISMATCH',
    );
    ensure(
      result.permite_pago === false && result.permite_consumo_cupon === false,
      'EXPIRED_RESERVATION_ALLOWED',
    );
    ensure(
      result.estado_persistido === 'EXPIRADA' ||
        result.vigencia_efectiva === 'VENCIDA',
      'RESERVATION_NOT_EXPIRED',
    );
    report({
      event: 'expiry',
      reservation_id: result.reservation_id,
      estado: result.estado_persistido,
      vigencia: result.vigencia_efectiva,
    });
    return;
  }
  if (action === 'coupon') {
    const result = await state();
    ensure(
      result?.order_id === order &&
        result.reservation_id === plan.reservation_id &&
        result.permite_consumo_cupon === true,
      'RESERVATION_NOT_VERIFIED',
    );
    ensure(
      uuid.test(plan.customer_ref) &&
        Number.isFinite(Date.parse(plan.effective_at)) &&
        plan.g5_snapshot_confirmed === true,
      'G5_SNAPSHOT_REQUIRED',
    );
    const body = {
      operation_id: operationId('coupon'),
      order_id: order,
      coupon_code: scenario.coupon_code,
      channel_id: scenario.channel_id,
      customer_ref: plan.customer_ref,
      effective_at: plan.effective_at,
      reservation_id: plan.reservation_id,
      commercial_snapshot_ref: order,
    };
    const path = '/cupones/consumos';
    const completed = await submit('cupones', path, body);
    ensure(
      completed.status === 'COMPLETED' &&
        uuid.test(completed.result?.consumption_id),
      'COUPON_NOT_COMPLETED',
    );
    const replay = await expectStatus('POST', path, [200], { body });
    ensure(
      replay?.result?.consumption_id === completed.result.consumption_id,
      'COUPON_REPLAY_DIFFERED',
    );
    await expectStatus('POST', path, [409], {
      body: { ...body, coupon_code: scenario.coupon_code + '_CONFLICTO' },
    });
    return;
  }
  if (action === 'confirm') {
    const payment = await constanciaComercial(plan, 'PAGO_CONFIRMADO');
    report({
      event: 'g5_evidence_verified',
      kind: payment.event,
      evidence_id: payment.event_id,
    });
    ensure(
      (await follow('cupones', operationId('coupon'))).status === 'COMPLETED',
      'COUPON_NOT_COMPLETED',
    );
    const result = await submit('inventario', reservation + '/confirmar', {
      order_id: order,
      operation_id: operationId('confirm'),
    });
    ensure(result.status === 'COMPLETED', 'STOCK_CONFIRMATION_FAILED');
    return;
  }

  const cancellation = await constanciaComercial(plan, 'ANULACION_CONFIRMADA');
  report({
    event: 'g5_evidence_verified',
    kind: cancellation.event,
    evidence_id: cancellation.event_id,
  });
  await executeCancellation(
    plan,
    cancellation,
    submit,
    operationId,
    reservationPath,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    const code = /^[A-Z0-9_]{1,100}$/.test(error?.message ?? '')
      ? error.message
      : 'INTEGRATION_RUN_FAILED';
    console.error(JSON.stringify({ event: 'failed', code }));
    process.exitCode = 1;
  });
