import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ejecutarBateria,
  ejecutarPreflight,
  validatePreflightEvidence,
} from './ejecutar-controlado.mjs';

const vars = [
  'G5_H5_AUTHORIZED_GATEWAY_ORIGIN',
  'G5_H5_VENTAS_JWT',
  'G5_H5_PRICING_READ_JWT',
  'G5_H5_COUPON_VALIDATION_JWT',
];
function assignEnv(name, value) {
  const previous = process.env[name];
  process.env[name] = value;
  return () =>
    previous === undefined
      ? delete process.env[name]
      : (process.env[name] = previous);
}

test('preflight exige las tres comprobaciones reales, correlacionadas y no mutantes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'g6-h5-preflight-'));
  const gateway = 'https://private-gateway.example.invalid';
  const restore = vars.map((name) =>
    assignEnv(name, name.endsWith('ORIGIN') ? gateway : 'test.jwt.value'),
  );
  t.after(async () => {
    restore.forEach((fn) => fn());
    await rm(dir, { recursive: true, force: true });
  });
  const plan = {
    environment: 'integration',
    gateway,
    case_id: 'G5-H5-01',
    order_id: 'PEDIDO-SINTETICO-01',
    g5_sha: '1'.repeat(40),
    g6_sha: '2'.repeat(40),
    correlation_id: randomUUID(),
    customer_ref: randomUUID(),
    scenario: {
      sku: 'SKU-VALIDADO',
      quantity: 2,
      channel_id: 'MARKETPLACE',
      coupon_code: 'CUPON-VALIDADO',
      currency: 'PEN',
      location_id: randomUUID(),
    },
  };
  const metadata = {
    environment: plan.environment,
    case_id: plan.case_id,
    order_id: plan.order_id,
    g5_sha: plan.g5_sha,
    g6_sha: plan.g6_sha,
    correlation_id: plan.correlation_id,
    scenario: { ...plan.scenario },
  };
  const validEvents = [
    {
      ...metadata,
      event: 'http',
      check: 'availability',
      method: 'GET',
      route: '/inventario/disponibilidad',
      request: {
        skus: plan.scenario.sku,
        location_id: plan.scenario.location_id,
      },
      status: 200,
    },
    {
      ...metadata,
      event: 'http',
      check: 'price',
      method: 'GET',
      route: '/precios/skus/SKU-VALIDADO',
      request: { canal: plan.scenario.channel_id },
      status: 200,
    },
    {
      ...metadata,
      event: 'http',
      check: 'coupon',
      method: 'POST',
      route: '/cupones/validar',
      request: {
        channel_id: plan.scenario.channel_id,
        coupon_code: plan.scenario.coupon_code,
        lines: [{ sku: plan.scenario.sku, quantity: plan.scenario.quantity }],
      },
      status: 200,
    },
    {
      ...metadata,
      event: 'read_only_preflight',
      available: 10,
      price: 20,
      discount: 5,
      sku: plan.scenario.sku,
      currency: 'PEN',
      eligible: true,
      price_sku: plan.scenario.sku,
      price_currency: 'PEN',
      discount_currency: 'PEN',
    },
  ];
  assert.equal(validatePreflightEvidence(validEvents, plan), true);
  assert.equal(
    validatePreflightEvidence(
      [
        ...validEvents,
        {
          ...metadata,
          event: 'preflight_dependency',
          service: 'catalog-readiness',
          status: 'PASS',
        },
      ],
      plan,
    ),
    true,
  );
  assert.equal(
    validatePreflightEvidence(
      [
        ...validEvents,
        {
          ...metadata,
          event: 'preflight_dependency',
          service: 'unknown',
          status: 'PASS',
        },
      ],
      plan,
    ),
    false,
  );

  const invalid = [
    [],
    validEvents.slice(0, 3),
    validEvents.filter((event) => event.check !== 'price'),
    validEvents.filter((event) => event.check !== 'availability'),
    validEvents.filter((event) => event.check !== 'coupon'),
    [...validEvents, validEvents[0]],
    [...validEvents, { ...validEvents[0], status: 503 }],
    validEvents.map((event, index) =>
      index === 0
        ? { ...event, method: 'POST', route: '/cupones/consumos' }
        : event,
    ),
    validEvents.map((event, index) =>
      index === 1 ? { ...event, route: '/precios/skus/OTRO' } : event,
    ),
    validEvents.map((event, index) =>
      index === 0
        ? { ...event, request: { ...event.request, skus: 'OTHER-SKU' } }
        : event,
    ),
    validEvents.map((event, index) =>
      index === 2 ? { ...event, order_id: 'PEDIDO-AJENO' } : event,
    ),
    validEvents.map((event, index) =>
      index === 0 ? { ...event, correlation_id: randomUUID() } : event,
    ),
    validEvents.map((event, index) =>
      index === 0 ? { ...event, g6_sha: 'f'.repeat(40) } : event,
    ),
    validEvents.map((event, index) =>
      index === 2 ? { ...event, g5_sha: 'f'.repeat(40) } : event,
    ),
    validEvents.map((event, index) =>
      index === 3 ? { ...event, eligible: false } : event,
    ),
    validEvents.map((event, index) =>
      index === 3 ? { ...event, available: 0 } : event,
    ),
    validEvents.map((event, index) =>
      index === 3 ? { ...event, price: 0 } : event,
    ),
    validEvents.map((event, index) =>
      index === 3 ? { ...event, discount: 1000 } : event,
    ),
    [
      ...validEvents,
      {
        ...metadata,
        event: 'http',
        check: 'extra',
        method: 'DELETE',
        route: '/x',
        status: 200,
      },
    ],
    [...validEvents, { ...metadata, event: 'unrecognized' }],
  ];
  for (const events of invalid)
    assert.equal(validatePreflightEvidence(events, plan), false);

  const planPath = join(dir, 'plan.json');
  await writeFile(planPath, JSON.stringify(plan));
  const manifest = { 'G5-H5-01': { plan: planPath } };
  const safeOutput = join(dir, 'safe.json');
  const safe = await ejecutarPreflight(
    manifest,
    ['G5-H5-01'],
    safeOutput,
    () => ({
      status: 0,
      stdout: validEvents.map((event) => JSON.stringify(event)).join('\n'),
    }),
  );
  assert.equal(safe.results[0].technical_status, 'PASS');
  assert.equal(safe.results[0].status, 'BLOCKED');
  assert.equal(
    JSON.parse(await readFile(safeOutput, 'utf8')).results[0].status,
    'BLOCKED',
  );

  for (const [index, events] of invalid.entries()) {
    const output = join(dir, `invalid-${index}.json`);
    const report = await ejecutarPreflight(
      manifest,
      ['G5-H5-01'],
      output,
      () => ({
        status: 0,
        stdout: events.map((event) => JSON.stringify(event)).join('\n'),
      }),
    );
    assert.equal(
      report.results[0].technical_status,
      'FAIL',
      `invalid fixture ${index}`,
    );
    assert.equal(
      report.results[0].status,
      'BLOCKED',
      `invalid fixture ${index}`,
    );
  }
  const malformed = await ejecutarPreflight(
    manifest,
    ['G5-H5-01'],
    join(dir, 'malformed.json'),
    () => ({ status: 0, stdout: '{not-json' }),
  );
  assert.equal(malformed.results[0].technical_status, 'FAIL');

  for (const name of [
    'G5_H5_VENTAS_JWT',
    'G5_H5_PRICING_READ_JWT',
    'G5_H5_COUPON_VALIDATION_JWT',
  ]) {
    const restoreMissing = assignEnv(name, '');
    try {
      await assert.rejects(
        ejecutarPreflight(
          manifest,
          ['G5-H5-01'],
          join(dir, `missing-${name}.json`),
          () => {
            assert.fail('preflight executed without all operation credentials');
          },
        ),
        /TOKEN_REQUIRED/,
      );
    } finally {
      restoreMissing();
    }
  }

  const mutationPlan = join(dir, 'mutation-plan.json');
  await writeFile(
    mutationPlan,
    JSON.stringify({ ...plan, case_id: 'G5-H5-01' }),
  );
  await assert.rejects(
    ejecutarBateria(
      {
        'G5-H5-01': { plan: mutationPlan, execute: true },
      },
      ['G5-H5-01'],
      join(dir, 'matrix.json'),
      async () => {
        throw new Error(
          'deployment must not be queried before mutation authorization',
        );
      },
    ),
    /MUTATION_AUTHORIZATION_FILE_REQUIRED_G5-H5-01/,
  );
});

test('runner productor emite case_id en las cuatro evidencias aceptadas por el consumidor', async (t) => {
  const dir = await mkdtemp(
    join(tmpdir(), 'g6-h5-preflight-producer-consumer-'),
  );
  const gateway = 'https://gateway.integration.example.invalid';
  const restore = vars.map((name) =>
    assignEnv(name, name.endsWith('ORIGIN') ? gateway : 'synthetic-test-jwt'),
  );
  t.after(async () => {
    restore.forEach((fn) => fn());
    await rm(dir, { recursive: true, force: true });
  });

  const plan = {
    environment: 'integration',
    gateway,
    case_id: 'G5-H5-01',
    order_id: 'SYNTHETIC-ORDER-01',
    g5_sha: '1'.repeat(40),
    g6_sha: '2'.repeat(40),
    correlation_id: randomUUID(),
    customer_ref: randomUUID(),
    scenario: {
      sku: 'SKU-VALIDADO',
      quantity: 2,
      channel_id: 'MARKETPLACE',
      coupon_code: 'CUPON-VALIDADO',
      currency: 'PEN',
      location_id: randomUUID(),
    },
  };
  const planPath = join(dir, 'plan.json');
  const preloadPath = join(dir, 'http-double.mjs');
  const tokenCapturePath = join(dir, 'tokens.jsonl');
  await writeFile(planPath, JSON.stringify(plan));
  await writeFile(
    preloadPath,
    `
    globalThis.fetch = async (input, options) => {
      const url = new URL(input);
      await import('node:fs/promises').then(({ appendFile }) => appendFile(
        process.env.G5_H5_TOKEN_CAPTURE,
        JSON.stringify({ route: url.pathname, authorization: options.headers.Authorization }) + '\\n',
      ));
      let body;
      if (url.pathname === '/api/v1/inventario/disponibilidad') body = { items: [{
        sku: 'SKU-VALIDADO', location_id: url.searchParams.get('location_id'), available: 12,
      }] };
      else if (url.pathname === '/api/v1/precios/skus/SKU-VALIDADO') body = {
        sku: 'SKU-VALIDADO', currency: 'PEN', precio_regular: '20.00',
      };
      else if (url.pathname === '/api/v1/cupones/validar') body = {
        valid: true, currency: 'PEN', discount_amount: '5.00',
      };
      else return new Response('{}', { status: 404 });
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
  `,
  );

  const producer = spawnSync(
    process.execPath,
    [
      '--import',
      pathToFileURL(preloadPath).href,
      fileURLToPath(new URL('./ejecutar-integracion.mjs', import.meta.url)),
      'preflight',
      planPath,
      join(dir, 'runtime.json'),
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        G5_H5_AUTHORIZED_GATEWAY_ORIGIN: gateway,
        G5_H5_VENTAS_JWT: 'synthetic-test-jwt',
        G5_H5_PRICING_READ_JWT: 'synthetic-pricing-jwt',
        G5_H5_COUPON_VALIDATION_JWT: 'synthetic-coupon-jwt',
        G5_H5_TOKEN_CAPTURE: tokenCapturePath,
      },
    },
  );
  assert.equal(producer.status, 0, producer.stderr);
  const emitted = producer.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    emitted.map((event) => event.event),
    ['http', 'http', 'http', 'read_only_preflight'],
  );
  assert.ok(emitted.every((event) => event.case_id === plan.case_id));
  const sentCredentials = (await readFile(tokenCapturePath, 'utf8'))
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.deepEqual(sentCredentials, [
    {
      route: '/api/v1/inventario/disponibilidad',
      authorization: 'Bearer synthetic-test-jwt',
    },
    {
      route: '/api/v1/precios/skus/SKU-VALIDADO',
      authorization: 'Bearer synthetic-pricing-jwt',
    },
    {
      route: '/api/v1/cupones/validar',
      authorization: 'Bearer synthetic-coupon-jwt',
    },
  ]);

  const manifest = { 'G5-H5-01': { plan: planPath } };
  const successful = await ejecutarPreflight(
    manifest,
    ['G5-H5-01'],
    join(dir, 'accepted.json'),
    () => ({ status: producer.status, stdout: producer.stdout }),
  );
  assert.equal(successful.results[0].technical_status, 'PASS');
  assert.equal(successful.results[0].status, 'BLOCKED');

  const invalidEvidence = [
    emitted.map((event, index) =>
      index === 3
        ? Object.fromEntries(
            Object.entries(event).filter(([key]) => key !== 'case_id'),
          )
        : event,
    ),
    emitted.map((event, index) =>
      index === 3 ? { ...event, case_id: 'G5-H5-02' } : event,
    ),
  ];
  for (const [index, evidence] of invalidEvidence.entries()) {
    const rejected = await ejecutarPreflight(
      manifest,
      ['G5-H5-01'],
      join(dir, `rejected-${index}.json`),
      () => ({
        status: 0,
        stdout: evidence.map((event) => JSON.stringify(event)).join('\n'),
      }),
    );
    assert.equal(rejected.results[0].technical_status, 'FAIL');
    assert.equal(rejected.results[0].status, 'BLOCKED');
  }

  assert.equal(
    validatePreflightEvidence(emitted, { ...plan, case_id: 'UNKNOWN-CASE' }),
    false,
  );
});
