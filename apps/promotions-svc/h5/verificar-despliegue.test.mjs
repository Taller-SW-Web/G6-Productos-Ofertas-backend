import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { verificarDespliegue } from './verificar-despliegue.mjs';

const repo = 'Taller-SW-Web/G6-Productos-Ofertas-backend';
const targets = JSON.parse(
  readFileSync(
    new URL(
      '../../../ops/azure/container-apps/deployment-targets.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const services = [
  'api-gateway',
  'promotions-svc',
  'inventory-svc',
  'catalog-svc',
];
const plan = {
  environment: 'integration',
  g6_sha: '1'.repeat(40),
  g6_destination: 'brazil-isolated',
  gateway: 'https://g6-private.example.invalid',
  g6_cd_runs: Object.fromEntries(
    services.map((service, index) => [service, 123 + index]),
  ),
};
const destination = (value) => targets.destinations[value];
const resourceRoot = (target) =>
  '/subscriptions/' +
  targets.subscriptionId +
  '/resourceGroups/' +
  target.resourceGroup +
  '/providers/Microsoft.App/';
const image = (service) =>
  'ghcr.io/' + repo.toLowerCase() + '/' + service + '@sha256:' + 'f'.repeat(64);
const serviceForRun = (runId, currentPlan) =>
  Object.entries(currentPlan.g6_cd_runs).find(
    ([, id]) => String(id) === String(runId),
  )?.[0];

function fixture(currentPlan = plan, change = (type, result) => result) {
  const target = destination(currentPlan.g6_destination);
  const root = resourceRoot(target);
  const output = (type, result) => JSON.stringify(change(type, result));
  return (cmd, args) => {
    if (cmd === 'gh' && args[0] === 'api') {
      if (args[1].includes('/variables/'))
        return output('subscription', { value: targets.subscriptionId });
      return output('workflow', {
        path: '.github/workflows/cd-services-azure.yml',
        repository: { full_name: repo },
        head_repository: { full_name: repo },
      });
    }
    if (cmd === 'gh' && args[1] === 'view') {
      const service = serviceForRun(args[2], currentPlan);
      return output('run', {
        databaseId: Number(args[2]),
        headSha: currentPlan.g6_service_shas?.[service] ?? currentPlan.g6_sha,
        headBranch: 'master',
        event: 'workflow_dispatch',
        conclusion: 'success',
        url: 'https://github.com/' + repo + '/actions/runs/' + args[2],
        jobs: services.map((name) => ({
          name: 'Desplegar ' + name + ' en Azure',
          conclusion: 'success',
          completedAt: '2026-11-21T18:00:00Z',
        })),
      });
    }
    if (cmd === 'gh' && args[1] === 'download') {
      const service = args[args.indexOf('-n') + 1].replace('azure-image-', '');
      writeFileSync(
        join(args[args.indexOf('-D') + 1], 'image-' + service + '.txt'),
        change('image', image(service)),
      );
      return '';
    }
    assert.equal(cmd, 'az');
    assert.equal(
      args[args.indexOf('--subscription') + 1],
      targets.subscriptionId,
    );
    assert.equal(
      args[args.indexOf('--resource-group') + 1],
      target.resourceGroup,
    );
    const service = args[args.indexOf('--name') + 1];
    if (args[1] === 'show')
      return output('app', {
        id: root + 'containerApps/' + service,
        environment: root + 'managedEnvironments/' + target.acaEnvironment,
        latest: service + '--r1',
        host: new URL(currentPlan.gateway).host,
      });
    return output('revision', [
      {
        name: service + '--r1',
        health: 'Healthy',
        traffic: 100,
        containers: [{ name: service, image: image(service) }],
      },
    ]);
  };
}

test('verifica destinos oficiales de Brasil y Chile y los digests activos', async () => {
  for (const g6_destination of ['brazil-isolated', 'chile-shared']) {
    const evidence = await verificarDespliegue(
      { ...plan, g6_destination },
      fixture({ ...plan, g6_destination }),
    );
    assert.deepEqual(
      evidence.map((entry) => entry.image),
      services.map(image),
    );
    assert.ok(
      evidence.every((entry) => entry.certification_status === 'SUCCESS'),
    );
    assert.ok(
      evidence.every((entry) => entry.effective_traffic_percent === 100),
    );
    assert.ok(evidence.every((entry) => entry.resource_id && entry.oci_digest));
    assert.ok(evidence.every((entry) => entry.origin_approved));
  }
});

test('acepta SHA fuente distinta por servicio cuando cada CD y digest lo demuestran', async () => {
  const currentPlan = {
    ...plan,
    g6_destination: 'chile-shared',
    g6_service_shas: Object.fromEntries(
      services.map((service) => [service, String(2).repeat(40)]),
    ),
  };
  const evidence = await verificarDespliegue(currentPlan, fixture(currentPlan));
  assert.deepEqual(
    evidence.map((entry) => entry.source_sha),
    services.map((service) => currentPlan.g6_service_shas[service]),
  );
  assert.ok(evidence.every((entry) => entry.destination === 'chile-shared'));
});

test('distingue despliegue observado de certificación cuando el workflow CD terminó con fallo', async () => {
  const evidence = await verificarDespliegue(
    { ...plan, g6_destination: 'chile-shared' },
    fixture({ ...plan, g6_destination: 'chile-shared' }, (type, record) =>
      type === 'run' ? { ...record, conclusion: 'failure' } : record,
    ),
  );
  assert.ok(
    evidence.every((entry) => entry.deploy_job_conclusion === 'success'),
  );
  assert.ok(
    evidence.every((entry) => entry.deployment_status === 'VERIFIED_SERVING'),
  );
  assert.ok(evidence.every((entry) => entry.cd_run_conclusion === 'failure'));
  assert.ok(
    evidence.every(
      (entry) => entry.certification_status === 'BLOCKED_CD_RUN_FAILURE',
    ),
  );
  assert.ok(
    evidence.every((entry) => entry.oci_digest === 'sha256:' + 'f'.repeat(64)),
  );
});

test('bloquea evidencia ausente, ajena, no servida o con procedencia cruzada', async () => {
  const cases = [
    ['workflow', (record) => ({ ...record, path: '.github/workflows/ci.yml' })],
    ['run', (record) => ({ ...record, headSha: '2'.repeat(40) })],
    ['run', (record) => ({ ...record, headBranch: 'cueva' })],
    ['run', (record) => ({ ...record, jobs: [] })],
    ['app', (record) => ({ ...record, host: 'wrong.example.invalid' })],
    [
      'app',
      (record) => ({
        ...record,
        environment:
          resourceRoot(destination(plan.g6_destination)) +
          'managedEnvironments/shared',
      }),
    ],
    ['revision', ([record]) => [{ ...record, name: 'previous' }]],
    ['revision', ([record]) => [{ ...record, traffic: 0 }]],
    [
      'revision',
      ([record]) => [record, { ...record, name: 'second', traffic: 100 }],
    ],
    [
      'revision',
      ([record]) => [
        {
          ...record,
          containers: record.containers.map((container) => ({
            ...container,
            image: container.image.replace(/f{64}$/, 'e'.repeat(64)),
          })),
        },
      ],
    ],
  ];
  for (const [target, override] of cases)
    await assert.rejects(
      verificarDespliegue(
        plan,
        fixture(plan, (type, record) =>
          type === target ? override(record) : record,
        ),
      ),
      /DESPLIEGUE_OFICIAL_NO_VERIFICADO/,
    );
  await assert.rejects(
    verificarDespliegue({ ...plan, g6_destination: 'invalid' }, fixture()),
    /DESPLIEGUE_OFICIAL_NO_VERIFICADO/,
  );
  await assert.rejects(
    verificarDespliegue({ ...plan, g6_cd_runs: {} }, fixture()),
    /DESPLIEGUE_OFICIAL_NO_VERIFICADO/,
  );
  await assert.rejects(
    verificarDespliegue(
      {
        ...plan,
        g6_cd_runs: Object.fromEntries(
          services.map((service) => [service, 123]),
        ),
      },
      fixture(),
    ),
    /DESPLIEGUE_OFICIAL_NO_VERIFICADO/,
  );
  await assert.rejects(
    verificarDespliegue(
      { ...plan, g6_service_shas: { 'api-gateway': 'invalid' } },
      fixture(),
    ),
    /DESPLIEGUE_OFICIAL_NO_VERIFICADO/,
  );
});
