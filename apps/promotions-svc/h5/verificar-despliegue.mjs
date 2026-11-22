import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = 'Taller-SW-Web/G6-Productos-Ofertas-backend';
const group = 'rg-g6-sb-h5-int-fork';
const services = [
  'api-gateway',
  'promotions-svc',
  'inventory-svc',
  'catalog-svc',
];
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const digest = /^sha256:[0-9a-f]{64}$/;
const unavailable = () => new Error('DESPLIEGUE_OFICIAL_NO_VERIFICADO');
const exec = (command, args) =>
  execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20_000,
  });

export async function verificarDespliegue(plan, execute = exec) {
  if (
    plan.environment !== 'integration' ||
    !/^[a-f0-9]{40}$/.test(plan.g6_sha) ||
    services.some(
      (service) =>
        !/^[1-9][0-9]{0,15}$/.test(String(plan.g6_cd_runs?.[service])),
    )
  )
    throw unavailable();
  const temp = await mkdtemp(join(tmpdir(), 'g6-h5-cd-'));
  const json = (cmd, args) => JSON.parse(execute(cmd, args));
  try {
    const subscription = json('gh', [
      'api',
      'repos/' +
        repo +
        '/environments/azure-h5/variables/AZURE_SUBSCRIPTION_ID',
    ]).value;
    if (!uuid.test(subscription)) throw unavailable();
    const runs = new Map();
    const verified = [];
    for (const service of services) {
      const runId = String(plan.g6_cd_runs[service]);
      let run = runs.get(runId);
      if (!run) {
        run = json('gh', [
          'run',
          'view',
          runId,
          '-R',
          repo,
          '--json',
          'databaseId,headSha,headBranch,event,conclusion,url,jobs',
        ]);
        const workflow = json('gh', [
          'api',
          'repos/' + repo + '/actions/runs/' + runId,
        ]);
        if (
          workflow.path !== '.github/workflows/cd-services-azure.yml' ||
          workflow.repository?.full_name?.toLowerCase() !==
            repo.toLowerCase() ||
          workflow.head_repository?.full_name?.toLowerCase() !==
            repo.toLowerCase() ||
          String(run.databaseId) !== runId ||
          run.headSha !== plan.g6_sha ||
          run.headBranch !== 'master' ||
          run.event !== 'workflow_dispatch' ||
          run.conclusion !== 'success' ||
          run.url !== 'https://github.com/' + repo + '/actions/runs/' + runId
        )
          throw unavailable();
        runs.set(runId, run);
      }
      const deploy = run.jobs.find(
        (job) => job.name === 'Desplegar ' + service + ' en Azure',
      );
      if (
        deploy?.conclusion !== 'success' ||
        !Number.isFinite(Date.parse(deploy.completedAt))
      )
        throw unavailable();
      execute('gh', [
        'run',
        'download',
        runId,
        '-R',
        repo,
        '-n',
        'azure-image-' + service,
        '-D',
        temp,
      ]);
      const image = (
        await readFile(join(temp, 'image-' + service + '.txt'), 'utf8')
      ).trim();
      const prefix = 'ghcr.io/' + repo.toLowerCase() + '/' + service + '@';
      if (!image.startsWith(prefix) || !digest.test(image.slice(prefix.length)))
        throw unavailable();

      const scope = [
        '--resource-group',
        group,
        '--subscription',
        subscription,
        '--output',
        'json',
      ];
      const app = json('az', [
        'containerapp',
        'show',
        '--name',
        service,
        ...scope,
        '--query',
        '{id:id,environment:properties.environmentId || properties.managedEnvironmentId,latest:properties.latestReadyRevisionName,host:properties.configuration.ingress.fqdn}',
      ]);
      const resource =
        '/subscriptions/' +
        subscription +
        '/resourceGroups/' +
        group +
        '/providers/Microsoft.App/';
      if (
        app.id?.toLowerCase() !==
          (resource + 'containerApps/' + service).toLowerCase() ||
        app.environment?.toLowerCase() !==
          (resource + 'managedEnvironments/env-g6-h5-int').toLowerCase() ||
        (service === 'api-gateway' &&
          new URL(plan.gateway).origin !== 'https://' + app.host)
      )
        throw unavailable();
      const active = json('az', [
        'containerapp',
        'revision',
        'list',
        '--name',
        service,
        ...scope,
        '--query',
        '[?properties.active].{name:name,health:properties.healthState,traffic:properties.trafficWeight,containers:properties.template.containers[].{name:name,image:image}}',
      ]);
      if (
        active.length !== 1 ||
        !app.latest ||
        active[0].name !== app.latest ||
        active[0].health !== 'Healthy' ||
        (service === 'api-gateway' && active[0].traffic !== 100) ||
        active[0].containers.filter(
          (c) => c.name === service && c.image === image,
        ).length !== 1
      )
        throw unavailable();
      verified.push({
        service,
        run_id: runId,
        run_url: run.url,
        deployed_at: deploy.completedAt,
        revision: app.latest,
        image,
      });
    }
    return verified;
  } catch {
    throw unavailable();
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
