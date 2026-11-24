import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ejecutarMatriz } from './ejecutar-matriz.mjs';

test('clasifica homologación técnica y bilateral', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'g6-h5-matrix-'));
  const plan = {
    environment: 'integration',
    gateway: 'https://integration.example.invalid',
    g5_sha: '1'.repeat(40),
    g6_sha: '2'.repeat(40),
    g5_deployment: {
      verification_status: 'VERIFIED',
      commit_sha: '1'.repeat(40),
      image_digest: 'sha256:' + '3'.repeat(64),
      revision: 'g5-test-revision',
      evidence_url: 'https://g5-evidence.example.invalid/deployment',
      verified_at: '2026-01-01T00:00:00Z',
      verified_by: 'G5 test fixture',
    },
    order_id: 'PED-AUDITADO',
    correlation_id: randomUUID(),
    reservation_id: randomUUID(),
    follow_type: 'cupones',
    follow_operation_id: randomUUID(),
    operations: { reserve: randomUUID(), coupon: randomUUID() },
    auth: { existing_coupon_operation_id: randomUUID(), foreign_order_id: 'PEDIDO-AJENO' },
  };
  const planPath = join(dir, 'plan.json');
  const keyPath = join(dir, 'public.pem');
  const keys = generateKeyPairSync('ed25519');
  const variable = 'G5_H5_SESSION_EVIDENCE_PUBLIC_KEY';
  const previous = process.env[variable];
  t.after(async () => {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(planPath, JSON.stringify(plan));
  await writeFile(
    keyPath,
    keys.publicKey.export({ type: 'spki', format: 'pem' }),
  );
  process.env[variable] = keyPath;
  const coupon = 'G5-H5-05';
  const fixture = { plan: planPath, execute: true, mutation_authorization: planPath };
  const admission = {
    method: 'POST',
    status: 202,
    operation_id: plan.operations.coupon,
  };
  const completion = {
    event: 'terminal',
    status: 'COMPLETED',
    operation_id: plan.operations.coupon,
  };
  const output = (...events) => ({
    status: 0,
    stdout: events
      .map((event) =>
        JSON.stringify({
          environment: plan.environment,
          g5_sha: plan.g5_sha,
          g6_sha: plan.g6_sha,
          order_id: plan.order_id,
          ...event,
        }),
      )
      .join('\n'),
  });
  const signed = (overrides = {}) => {
    const payload = Buffer.from(
      JSON.stringify({
        case_id: coupon,
        actor: 'G5+G6',
        environment: plan.environment,
        gateway: plan.gateway,
        g5_sha: plan.g5_sha,
        g6_sha: plan.g6_sha,
        order_id: plan.order_id,
        operation_or_reservation_id: plan.operations.coupon,
        observed_at: new Date().toISOString(),
        observed: 'CUPON_202_Y_COMPLETED',
        evidence_url: 'https://evidence.example.invalid/coupon',
        status: 'PASS',
        ...overrides,
      }),
    );
    return {
      payload: payload.toString('base64url'),
      signature: sign(null, payload, keys.privateKey).toString('base64url'),
    };
  };
  const deployment = async () => [
    { deployed_at: '2026-01-01T00:00:00Z', revision: 'fixture' },
  ];
  const scenario = async (id, record, result, verify = deployment) => {
    const report = await ejecutarMatriz(
      { [id]: record },
      [id],
      () => result,
      verify,
      async () => undefined,
    );
    assert.equal(report.results.length, 20);
    return report.results.find((row) => row.id === id);
  };
  const validRun = output(admission, completion);
  const operation = plan.follow_operation_id;
  const message = randomUUID();
  const observed = {
    'G5-H5-07': 'INTENCION_UNICA_RECUPERADA',
    'G5-H5-15': 'OUTBOX_RECUPERADO_TRAS_REINICIO',
    'G5-H5-16': 'UN_EFECTO_Y_SETTLEMENT',
  };
  const completed = {
    event: 'terminal',
    operation_id: operation,
    status: 'COMPLETED',
    completed_at: '2026-01-02T00:05:00Z',
  };
  const facts = {
    'G5-H5-07': {
      operation_id: operation,
      request_operation_id: operation,
      recovered_operation_id: operation,
      operation_rows: 1,
      effect_count: 1,
      response_lost_at: '2026-01-02T00:01:00Z',
      recovered_at: '2026-01-02T00:05:00Z',
    },
    'G5-H5-15': {
      operation_id: operation,
      message_id: message,
      outbox_pending_message_id: message,
      outbox_recovered_message_id: message,
      worker_before: 'worker-a',
      worker_after: 'worker-b',
      outbox_pending_at: '2026-01-02T00:01:00Z',
      worker_stopped_at: '2026-01-02T00:02:00Z',
      worker_restarted_at: '2026-01-02T00:03:00Z',
      outbox_recovered_at: '2026-01-02T00:04:00Z',
      terminal_at: completed.completed_at,
    },
    'G5-H5-16': {
      operation_id: operation,
      message_id: message,
      inbox_message_id: message,
      inbox_rows: 1,
      effect_count: 1,
      deliveries: [
        {
          trace_id: 'trace-1',
          message_id: message,
          settlement: 'LOCK_LOST',
          observed_at: '2026-01-02T00:06:00Z',
        },
        {
          trace_id: 'trace-2',
          message_id: message,
          settlement: 'COMPLETED',
          observed_at: '2026-01-02T00:07:00Z',
        },
      ],
    },
  };
  const runtimeProof = (id, runtime = facts[id]) =>
    signed({
      case_id: id,
      actor: 'G6',
      observed: observed[id],
      runtime_evidence: runtime,
      operation_or_reservation_id: operation,
    });
  const followRun = output(completed);
  await t.test(
    'ningún caso con etapa aprueba si execute no está habilitado, incluso 07 con firma válida',
    async () => {
      const empty = await ejecutarMatriz({});
      let executed = 0;
      const records = Object.fromEntries(
        empty.results
          .filter((row) => row.stage !== null)
          .map((row) => [
            row.id,
            {
              ...fixture,
              execute: false,
              attestation:
                row.id === 'G5-H5-07'
                  ? runtimeProof(row.id)
                  : signed({
                      case_id: row.id,
                      actor: row.actor,
                      observed: row.expected,
                    }),
            },
          ]),
      );
      const report = await ejecutarMatriz(
        records,
        [],
        () => {
          executed++;
          return followRun;
        },
        deployment,
      );
      assert.equal(executed, 0);
      for (const row of report.results.filter((r) => r.stage !== null)) {
        assert.equal(row.status, 'BLOCKED', row.id);
        assert.equal(row.reason, 'FALTA_EJECUCION_TECNICA', row.id);
        assert.equal(row.technical_status, 'NOT_RUN', row.id);
      }
    },
  );
  await t.test(
    '07, 15 y 16 requieren hechos específicos con firma, ejecución y CD',
    async () => {
      const incomplete = {
        'G5-H5-07': { recovered_operation_id: randomUUID() },
        'G5-H5-15': { worker_after: facts['G5-H5-15'].worker_before },
        'G5-H5-16': {
          deliveries: [
            facts['G5-H5-16'].deliveries[0],
            {
              ...facts['G5-H5-16'].deliveries[1],
              message_id: randomUUID(),
            },
          ],
        },
      };
      for (const id of Object.keys(facts)) {
        assert.equal(
          (await scenario(id, fixture, followRun)).status,
          'BLOCKED',
          id,
        );
        assert.equal(
          (
            await scenario(
              id,
              { ...fixture, attestation: runtimeProof(id, {}) },
              followRun,
            )
          ).status,
          'BLOCKED',
          id,
        );
        const crossed = { ...facts[id], ...incomplete[id] };
        assert.equal(
          (
            await scenario(
              id,
              { ...fixture, attestation: runtimeProof(id, crossed) },
              followRun,
            )
          ).status,
          'BLOCKED',
          id,
        );

        const verified = { ...fixture, attestation: runtimeProof(id) };
        const passed = await scenario(id, verified, followRun);
        assert.equal(passed.status, 'PASS', id);
        assert.equal(passed.technical_status, 'PASS', id);
        assert.equal(
          (
            await scenario(id, verified, {
              status: 1,
              stderr: '{"code":"TERMINAL_TIMEOUT_REUSE_OPERATION_ID"}',
            })
          ).status,
          'FAIL',
          id,
        );
        assert.equal(
          (
            await scenario(id, verified, followRun, async () => {
              throw new Error();
            })
          ).status,
          'BLOCKED',
          id,
        );
      }
    },
  );
  await t.test(
    'un PASS automático G6 tampoco puede sustituir al CD oficial',
    async () => {
      const reserve = output({
        event: 'terminal',
        status: 'COMPLETED',
        operation_id: plan.operations.reserve,
        reservation_id: plan.reservation_id,
      });
      const row = await scenario('G5-H5-01', fixture, reserve, async () => {
        throw new Error();
      });
      assert.equal(row.status, 'BLOCKED');
      assert.equal(row.technical_status, 'NOT_RUN');
      assert.equal(row.reason, 'DESPLIEGUE_OFICIAL_NO_VERIFICADO');
    },
  );
  await t.test('G5-H5-05 sin constancia queda BLOCKED', async () => {
    const row = await scenario(coupon, fixture, validRun);
    assert.equal(row.status, 'BLOCKED');
    assert.equal(row.reason, 'FALTA_CONSTANCIA_BILATERAL');
  });
  await t.test('G5-H5-09 requiere follow técnico y constancia bilateral', async () => {
    const followPlan = { ...plan, order_id: 'PEDIDO-G5-09', follow_operation_id: randomUUID(), case_id: 'G5-H5-09' };
    const followFile = join(dir, 'follow-09-plan.json');
    await writeFile(followFile, JSON.stringify(followPlan));
    const record = { plan: followFile, execute: true, mutation_authorization: followFile };
    const terminal = { status: 0, stdout: JSON.stringify({
      environment: followPlan.environment, g5_sha: followPlan.g5_sha, g6_sha: followPlan.g6_sha,
      order_id: followPlan.order_id, event: 'terminal', operation_id: followPlan.follow_operation_id, status: 'COMPLETED',
    }) };
    const noProof = await scenario('G5-H5-09', record, terminal);
    assert.equal(noProof.technical_status, 'PASS', noProof.reason);
    assert.equal(noProof.status, 'BLOCKED');
    assert.equal(noProof.reason, 'FALTA_CONSTANCIA_BILATERAL');
    const noExecution = await scenario('G5-H5-09', { ...record, execute: false, attestation: signed({
      case_id: 'G5-H5-09', actor: 'G5', operation_or_reservation_id: followPlan.follow_operation_id,
      observed: 'M1_RECUPERA_AL_REINICIAR',
    }) }, terminal);
    assert.equal(noExecution.technical_status, 'NOT_RUN');
    assert.equal(noExecution.status, 'BLOCKED');
    assert.equal(noExecution.reason, 'FALTA_EJECUCION_TECNICA');
  });
  await t.test('G5-H5-05 con ambas evidencias pasa', async () => {
    assert.equal(
      (await scenario(coupon, { ...fixture, attestation: signed() }, validRun))
        .status,
      'PASS',
    );
  });
  await t.test(
    'sin CD verificable o con cambio de revisión no hay homologación',
    async () => {
      const signedFixture = { ...fixture, attestation: signed() };
      let ran = false;
      const report = await ejecutarMatriz(
        { [coupon]: signedFixture },
        [coupon],
        () => {
          ran = true;
          return validRun;
        },
        async () => {
          throw new Error();
        },
      async () => undefined,
      );
      assert.equal(ran, false);
      assert.equal(
        report.results[4].reason,
        'DESPLIEGUE_OFICIAL_NO_VERIFICADO',
      );
      let checks = 0;
      const row = await scenario(coupon, signedFixture, validRun, async () => [
        { deployed_at: '2026-01-01T00:00:00Z', revision: String(++checks) },
      ]);
      assert.equal(row.status, 'BLOCKED');
      assert.equal(row.reason, 'DESPLIEGUE_OFICIAL_CAMBIO_O_NO_VERIFICADO');
    },
  );
  await t.test(
    'G5-H5-05 conserva el FAIL técnico aunque exista constancia',
    async () => {
      for (const result of [
        { status: 1, stderr: '{"code":"COUPON_NOT_COMPLETED"}' },
        output(admission, { ...completion, operation_id: randomUUID() }),
        output(admission, { ...completion, g6_sha: 'd'.repeat(40) }),
        output(admission),
      ])
        assert.equal(
          (
            await scenario(
              coupon,
              { ...fixture, attestation: signed() },
              result,
            )
          ).status,
          'FAIL',
        );
    },
  );
  await t.test(
    'para G5-H5-05 la firma o los vínculos incorrectos y la ejecución ausente bloquean',
    async () => {
      for (const attestation of [
        { ...signed(), signature: Buffer.alloc(64).toString('base64url') },
        signed({ case_id: 'G5-H5-02' }),
        signed({ environment: 'production' }),
        signed({ g6_sha: 'a'.repeat(40) }),
        signed({ g5_sha: 'b'.repeat(40) }),
        signed({ order_id: 'OTRO' }),
        signed({ operation_or_reservation_id: plan.reservation_id }),
        signed({ operation_or_reservation_id: plan.operations.reserve }),
      ])
        assert.equal(
          (await scenario(coupon, { ...fixture, attestation }, validRun))
            .status,
          'BLOCKED',
        );
      assert.equal(
        (
          await scenario(
            coupon,
            { ...fixture, execute: false, attestation: signed() },
            validRun,
          )
        ).status,
        'BLOCKED',
      );
    },
  );
  await t.test('no inicia etapas sin evidencia revisada del SHA desplegado de G5', async () => {
    const badPlan = join(dir, 'unverified-g5-plan.json');
    await writeFile(
      badPlan,
      JSON.stringify({ ...plan, g5_deployment: { ...plan.g5_deployment, commit_sha: '9'.repeat(40) } }),
    );
    let executed = false;
    const report = await ejecutarMatriz(
      { [coupon]: { ...fixture, plan: badPlan } },
      [coupon],
      () => { executed = true; return validRun; },
      deployment,
    );
    const row = report.results.find((item) => item.id === coupon);
    assert.equal(executed, false);
    assert.equal(row.status, 'BLOCKED');
    assert.equal(row.technical_status, 'NOT_RUN');
    assert.equal(row.reason, 'SHA_G5_SIN_EVIDENCIA_VERIFICADA');
  });
  await t.test(
    'exige constancia en un caso G7 y permite PASS automático para G6',
    async () => {
      assert.equal(
        (
          await scenario(
            'G5-H5-14',
            fixture,
            output({
              event: 'uniform_coupon_not_found',
              correlation_id: plan.correlation_id,
            }),
          )
        ).status,
        'BLOCKED',
      );
      const reserve = output({
        event: 'terminal',
        status: 'COMPLETED',
        operation_id: plan.operations.reserve,
        reservation_id: plan.reservation_id,
      });
      assert.equal(
        (await scenario('G5-H5-01', fixture, reserve)).status,
        'PASS',
      );
    },
  );
  await t.test(
    'los cuatro casos G6 rechazan un SHA o UUID cruzado aunque haya otro evento relacionado',
    async () => {
      const cases = [
        [
          'G5-H5-01',
          'operation_id',
          plan.operations.reserve,
          {
            event: 'terminal',
            status: 'COMPLETED',
            reservation_id: plan.reservation_id,
          },
        ],
        [
          'G5-H5-08',
          'operation_id',
          plan.operations.coupon,
          { method: 'POST', status: 409, code: 'IDEMPOTENCY_CONFLICT' },
        ],
        [
          'G5-H5-10',
          'reservation_id',
          plan.reservation_id,
          { event: 'expiry', estado: 'ACTIVA', vigencia: 'VENCIDA' },
        ],
        [
          'G5-H5-13',
          'operation_id',
          plan.auth.existing_coupon_operation_id,
          { event: 'uniform_coupon_not_found' },
        ],
      ];
      for (const [id, field, identifier, observation] of cases) {
        const event = { ...observation, [field]: identifier };
        assert.equal(
          (await scenario(id, fixture, output(event))).status,
          'PASS',
          id,
        );
        for (const wrong of [
          { [field]: randomUUID() },
          { g6_sha: 'e'.repeat(40) },
        ]) {
          const row = await scenario(
            id,
            fixture,
            output({ [field]: identifier }, { ...event, ...wrong }),
          );
          assert.equal(row.status, 'FAIL', id);
        }
      }
    },
  );
});

test('runner usa escenarios.json como fuente única de ID, actor, etapa y expectativa', async () => {
  const catalog = JSON.parse(await readFile(new URL('./escenarios.json', import.meta.url), 'utf8'));
  const report = await ejecutarMatriz({});
  assert.equal(report.results.length, 20);
  assert.deepEqual(report.results.map(({ id }) => id), catalog.map(({ id }) => id));
  for (const scenario of catalog) {
    const row = report.results.find((entry) => entry.id === scenario.id);
    assert.equal(row.actor, scenario.actor, scenario.id);
    assert.equal(row.stage, scenario.stage, scenario.id);
    assert.equal(row.expected, scenario.expected, scenario.id);
    assert.equal(row.preconditions, scenario.preconditions, scenario.id);
  }
});

test('ejecutar-matriz directo bloquea reserve si falta autorización firmada', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'g6-h5-direct-matrix-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const planPath = join(dir, 'plan.json');
  await writeFile(planPath, JSON.stringify({
    case_id: 'G5-H5-01', environment: 'integration', gateway: 'https://gateway.example.invalid',
    g5_sha: '1'.repeat(40), g6_sha: '2'.repeat(40), order_id: 'SYNTHETIC-ORDER',
    correlation_id: randomUUID(), reservation_id: randomUUID(),
    operations: { reserve: randomUUID() },
    g5_deployment: { verification_status: 'VERIFIED', commit_sha: '1'.repeat(40),
      image_digest: 'sha256:' + 'a'.repeat(64), revision: 'test-revision',
      evidence_url: 'https://evidence.example.invalid/deployment', verified_by: 'test', verified_at: '2026-01-01T00:00:00Z' },
  }));
  let stageRan = false;
  let deploymentRead = false;
  const report = await ejecutarMatriz({ 'G5-H5-01': { plan: planPath, execute: true } }, ['G5-H5-01'], () => {
    stageRan = true; return { status: 0, stdout: '' };
  }, async () => { deploymentRead = true; return []; });
  const row = report.results.find((entry) => entry.id === 'G5-H5-01');
  assert.equal(row.status, 'BLOCKED');
  assert.equal(row.reason, 'MUTATION_AUTHORIZATION_FILE_REQUIRED');
  assert.equal(stageRan, false);
  assert.equal(deploymentRead, false);
});
