import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { verificarDespliegue } from './verificar-despliegue.mjs';

const repo = 'Taller-SW-Web/G6-Productos-Ofertas-backend';
const subscription = '11111111-1111-4111-8111-111111111111';
const root =
  '/subscriptions/' +
  subscription +
  '/resourceGroups/rg-g6-sb-h5-int-fork/providers/Microsoft.App/';
const services = [
  'api-gateway',
  'promotions-svc',
  'inventory-svc',
  'catalog-svc',
];
const plan = {
  environment: 'integration',
  g6_sha: '1'.repeat(40),
  gateway: 'https://g6-private.example.invalid',
  g6_cd_runs: Object.fromEntries(services.map((service, index) => [service, 123 + index])),
};
const image = (service) =>
  'ghcr.io/' + repo.toLowerCase() + '/' + service + '@sha256:' + 'f'.repeat(64);

function fixture(change = (type, result) => result) {
  const output = (type, result) => JSON.stringify(change(type, result));
  return (cmd, args) => {
    if (cmd === 'gh' && args[0] === 'api') {
      if (args[1].includes('/variables/'))
        return output('subscription', { value: subscription });
      return output('workflow', {
        path: '.github/workflows/cd-services-azure.yml',
        repository: { full_name: repo },
        head_repository: { full_name: repo },
      });
    }
    if (cmd === 'gh' && args[1] === 'view')
      return output('run', {
        databaseId: Number(args[2]),
        headSha: plan.g6_sha,
        headBranch: 'master',
        event: 'workflow_dispatch',
        conclusion: 'success',
        url: 'https://github.com/' + repo + '/actions/runs/' + args[2],
        jobs: services.map((service) => ({
          name: 'Desplegar ' + service + ' en Azure',
          conclusion: 'success',
          completedAt: '2026-11-21T18:00:00Z',
        })),
      });
    if (cmd === 'gh' && args[1] === 'download') {
      const service = args[args.indexOf('-n') + 1].replace('azure-image-', '');
      writeFileSync(
        join(args[args.indexOf('-D') + 1], 'image-' + service + '.txt'),
        change('image', image(service)),
      );
      return '';
    }
    assert.equal(cmd, 'az');
    assert.equal(args[args.indexOf('--subscription') + 1], subscription);
    const service = args[args.indexOf('--name') + 1];
    if (args[1] === 'show')
      return output('app', {
        id: root + 'containerApps/' + service,
        environment: root + 'managedEnvironments/env-g6-h5-int',
        latest: service + '--r1',
        host: new URL(plan.gateway).host,
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

test('verifica los cuatro digests del CD oficial contra las revisiones activas aisladas', async () => {
  const evidence = await verificarDespliegue(plan, fixture());
  assert.deepEqual(
    evidence.map((entry) => entry.image),
    services.map(image),
  );
});

test('bloquea evidencia ausente, ajena o con revisiones cruzadas', async () => {
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
        environment: root + 'managedEnvironments/shared',
      }),
    ],
    ['revision', ([record]) => [{ ...record, name: 'previous' }]],
    [
      'revision',
      ([record]) => [
        {
          ...record,
          containers: record.containers.map((c) => ({
            ...c,
            image: c.image.replace(/f{64}$/, 'e'.repeat(64)),
          })),
        },
      ],
    ],
    ['revision', ([record]) => [record, record]],
  ];
  for (const [target, override] of cases)
    await assert.rejects(
      verificarDespliegue(
        plan,
        fixture((type, record) =>
          type === target ? override(record) : record,
        ),
      ),
      /DESPLIEGUE_OFICIAL_NO_VERIFICADO/,
    );
  await assert.rejects(
    verificarDespliegue({ ...plan, g6_cd_runs: {} }, fixture()),
    /DESPLIEGUE_OFICIAL_NO_VERIFICADO/,
  );
  await assert.rejects(
    verificarDespliegue({ ...plan, g6_cd_runs: Object.fromEntries(services.map((service) => [service, 123])) }, fixture()),
    /DESPLIEGUE_OFICIAL_NO_VERIFICADO/,
  );
  await assert.rejects(
    verificarDespliegue(
      plan,
      fixture((type, value) => {
        if (type === 'image') throw new Error('ARTIFACT_EXPIRED');
        return value;
      }),
    ),
    /DESPLIEGUE_OFICIAL_NO_VERIFICADO/,
  );
});
