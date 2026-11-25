import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  requiredDeploymentServices,
  verificarDespliegue,
} from './verificar-despliegue.mjs';

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
  case_id: 'G5-H5-05',
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
      if (change('download', service) === null)
        throw new Error('ARTIFACT_UNAVAILABLE');
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
        host:
          currentPlan.gateway_route_profile === 'g5-labelled'
            ? new URL(currentPlan.gateway).host.replace('---g5-h5', '')
            : new URL(currentPlan.gateway).host,
        mode:
          currentPlan.gateway_route_profile === 'g5-labelled'
            ? 'Multiple'
            : 'Single',
        traffic:
          service === 'api-gateway' &&
          currentPlan.gateway_route_profile === 'g5-labelled'
            ? [
                {
                  label: '',
                  revisionName: 'api-gateway--marketplace',
                  weight: 100,
                },
                { label: 'g5-h5', revisionName: 'api-gateway--r1', weight: 0 },
              ]
            : undefined,
      });
    if (
      service === 'api-gateway' &&
      currentPlan.gateway_route_profile === 'g5-labelled'
    )
      return output('revision', [
        {
          name: 'api-gateway--r1',
          health: 'Healthy',
          traffic: 0,
          containers: [{ name: service, image: image(service) }],
        },
        {
          name: 'api-gateway--marketplace',
          health: 'Healthy',
          traffic: 100,
          containers: [{ name: service, image: image(service) }],
        },
      ]);
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

test('reserva y rechazo de stock insuficiente requieren solo Gateway e Inventory', async () => {
  for (const case_id of ['G5-H5-01', 'G5-H5-02']) {
    const currentPlan = {
      ...plan,
      case_id,
      g6_cd_runs: { 'api-gateway': 501, 'inventory-svc': 503 },
    };
    assert.deepEqual(requiredDeploymentServices(currentPlan, 'reserve'), [
      'api-gateway',
      'inventory-svc',
    ]);
    const evidence = await verificarDespliegue(
      currentPlan,
      'reserve',
      fixture(currentPlan),
    );
    assert.deepEqual(
      evidence.map((entry) => entry.service),
      ['api-gateway', 'inventory-svc'],
    );
  }
});

test('perfil Chile etiqueta G5 certifica Gateway e Inventory con Marketplace al 100%', async () => {
  const gateway =
    'https://api-gateway---g5-h5.env-g6-phase1-chile.chilecentral.azurecontainerapps.io';
  const currentPlan = {
    ...plan,
    case_id: 'G5-H5-01',
    g6_destination: 'chile-shared',
    gateway,
    gateway_route_profile: 'g5-labelled',
    g6_cd_runs: { 'api-gateway': 501, 'inventory-svc': 503 },
  };
  const evidence = await verificarDespliegue(
    currentPlan,
    'reserve',
    fixture(currentPlan),
  );
  assert.deepEqual(
    evidence.map(({ service }) => service),
    ['api-gateway', 'inventory-svc'],
  );
  const gatewayEvidence = evidence[0];
  assert.equal(gatewayEvidence.route_mode, 'revision_label');
  assert.equal(gatewayEvidence.traffic_scope, 'label_url');
  assert.equal(
    gatewayEvidence.marketplace_revision,
    'api-gateway--marketplace',
  );
  assert.equal(gatewayEvidence.marketplace_traffic_percent, 100);
  assert.equal(gatewayEvidence.revision, 'api-gateway--r1');
  assert.equal(gatewayEvidence.certification_status, 'SUCCESS');
});

test('perfil Chile etiquetado rechaza label ausente o tráfico Marketplace alterado', async () => {
  const currentPlan = {
    ...plan,
    case_id: 'G5-H5-01',
    g6_destination: 'chile-shared',
    gateway:
      'https://api-gateway---g5-h5.env-g6-phase1-chile.chilecentral.azurecontainerapps.io',
    gateway_route_profile: 'g5-labelled',
    g6_cd_runs: { 'api-gateway': 501, 'inventory-svc': 503 },
  };
  for (const alter of [
    (app) => ({
      ...app,
      traffic: app.traffic.filter((route) => route.label !== 'g5-h5'),
    }),
    (app) => ({
      ...app,
      traffic: app.traffic.map((route) =>
        route.label ? route : { ...route, weight: 50 },
      ),
    }),
  ]) {
    await assert.rejects(
      verificarDespliegue(
        currentPlan,
        'reserve',
        fixture(currentPlan, (type, record) =>
          type === 'app' ? alter(record) : record,
        ),
      ),
      /DESPLIEGUE_OFICIAL_NO_VERIFICADO/,
    );
  }
});

test('rechaza caso desconocido, etapa cruzada y dependencias follow incompletas', () => {
  assert.throws(
    () =>
      requiredDeploymentServices({ ...plan, case_id: 'G5-H5-99' }, 'reserve'),
    /DESPLIEGUE_OFICIAL_NO_VERIFICADO/,
  );
  assert.throws(
    () =>
      requiredDeploymentServices({ ...plan, case_id: 'G5-H5-01' }, 'coupon'),
    /DESPLIEGUE_OFICIAL_NO_VERIFICADO/,
  );
  assert.throws(
    () =>
      requiredDeploymentServices(
        { ...plan, case_id: 'G5-H5-07', follow_type: 'unknown' },
        'follow',
      ),
    /DESPLIEGUE_OFICIAL_NO_VERIFICADO/,
  );
});

test('confirmación requiere Gateway e Inventory y mantiene el caso de pago firmado', async () => {
  const currentPlan = {
    ...plan,
    case_id: 'G5-H5-03',
    g6_cd_runs: { 'api-gateway': 501, 'inventory-svc': 503 },
  };
  assert.deepEqual(requiredDeploymentServices(currentPlan, 'confirm'), [
    'api-gateway',
    'inventory-svc',
  ]);
  assert.deepEqual(
    requiredDeploymentServices(
      { ...currentPlan, case_id: 'G5-H5-05' },
      'coupon',
    ),
    ['api-gateway', 'promotions-svc', 'inventory-svc', 'catalog-svc'],
  );
  assert.deepEqual(
    requiredDeploymentServices(
      { ...currentPlan, case_id: 'G5-H5-12', follow_type: 'cupones' },
      'follow',
    ),
    ['api-gateway', 'promotions-svc', 'inventory-svc'],
  );
  assert.throws(
    () =>
      requiredDeploymentServices(
        { ...currentPlan, case_id: 'G5-H5-01' },
        'confirm',
      ),
    /DESPLIEGUE_OFICIAL_NO_VERIFICADO/,
  );
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

test('un CD fallido con digest de artefacto distinto conserva solo la observación y bloquea la mutación', async () => {
  const currentPlan = { ...plan, g6_destination: 'chile-shared' };
  const evidence = await verificarDespliegue(
    currentPlan,
    'coupon',
    fixture(currentPlan, (type, record) => {
      if (type === 'run') return { ...record, conclusion: 'failure' };
      if (type === 'revision')
        return record.map((revision) => ({
          ...revision,
          containers: revision.containers.map((container) => ({
            ...container,
            image: container.image.replace(/f{64}$/, 'e'.repeat(64)),
          })),
        }));
      return record;
    }),
  );
  assert.ok(
    evidence.every((entry) => entry.deployment_status === 'VERIFIED_SERVING'),
  );
  assert.ok(evidence.every((entry) => !entry.provenance_matches_serving));
  assert.ok(
    evidence.every((entry) => entry.certification_status !== 'SUCCESS'),
  );
  assert.ok(
    evidence.every((entry) => entry.oci_digest === 'sha256:' + 'e'.repeat(64)),
  );
});

test('artifact unavailable permits serving observation but never CD certification', async () => {
  const currentPlan = {
    ...plan,
    case_id: 'G5-H5-01',
    g6_cd_runs: { 'api-gateway': 501, 'inventory-svc': 503 },
  };
  const evidence = await verificarDespliegue(
    currentPlan,
    'reserve',
    fixture(currentPlan, (type, record) =>
      type === 'download' ? null : record,
    ),
  );
  assert.ok(
    evidence.every((entry) => entry.deployment_status === 'VERIFIED_SERVING'),
  );
  assert.ok(
    evidence.every(
      (entry) =>
        entry.certification_status === 'BLOCKED_CD_EVIDENCE_INSUFFICIENT',
    ),
  );
});

test('bloquea evidencia ausente, ajena, no servida o con procedencia cruzada', async () => {
  const cases = [
    ['workflow', (record) => ({ ...record, path: '.github/workflows/ci.yml' })],
    ['run', (record) => ({ ...record, headSha: '2'.repeat(40) })],
    ['run', (record) => ({ ...record, headBranch: 'cueva' })],
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
  const missingJobEvidence = await verificarDespliegue(
    plan,
    'coupon',
    fixture(plan, (type, record) =>
      type === 'run' ? { ...record, jobs: [] } : record,
    ),
  );
  assert.ok(
    missingJobEvidence.every(
      (entry) =>
        entry.deployment_status === 'VERIFIED_SERVING' &&
        entry.certification_status === 'BLOCKED_DEPLOY_JOB_MISSING',
    ),
  );
  await assert.rejects(
    verificarDespliegue({ ...plan, g6_destination: 'invalid' }, fixture()),
    /DESPLIEGUE_OFICIAL_NO_VERIFICADO/,
  );
  await assert.rejects(
    verificarDespliegue(
      {
        ...plan,
        case_id: 'G5-H5-01',
        g6_cd_runs: { 'api-gateway': 501 },
      },
      'reserve',
      fixture(),
    ),
    /DESPLIEGUE_OFICIAL_NO_VERIFICADO/,
  );
  await assert.rejects(
    verificarDespliegue({ ...plan, g6_cd_runs: {} }, fixture()),
    /DESPLIEGUE_OFICIAL_NO_VERIFICADO/,
  );
  const sharedRunEvidence = await verificarDespliegue(
    {
      ...plan,
      g6_cd_runs: Object.fromEntries(services.map((service) => [service, 123])),
    },
    fixture(),
  );
  assert.ok(
    sharedRunEvidence.every(
      (entry) => entry.certification_status === 'SUCCESS',
    ),
  );
  await assert.rejects(
    verificarDespliegue(
      { ...plan, g6_service_shas: { 'api-gateway': 'invalid' } },
      fixture(),
    ),
    /DESPLIEGUE_OFICIAL_NO_VERIFICADO/,
  );
});
