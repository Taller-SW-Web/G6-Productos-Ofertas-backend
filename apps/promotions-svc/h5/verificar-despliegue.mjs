import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = 'Taller-SW-Web/G6-Productos-Ofertas-backend';
const deploymentTargets = JSON.parse(
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
  const destination = deploymentTargets.destinations?.[plan.g6_destination];
  if (
    plan.environment !== 'integration' ||
    !/^[a-f0-9]{40}$/.test(plan.g6_sha) ||
    !destination ||
    !['brazil-isolated', 'chile-shared'].includes(plan.g6_destination) ||
    (plan.g6_service_shas !== undefined &&
      (typeof plan.g6_service_shas !== 'object' ||
        services.some(
          (service) =>
            !/^[a-f0-9]{40}$/.test(plan.g6_service_shas?.[service] ?? ''),
        ))) ||
    new Set(services.map((service) => String(plan.g6_cd_runs?.[service])))
      .size !== services.length ||
    services.some(
      (service) =>
        !/^[1-9][0-9]{0,15}$/.test(String(plan.g6_cd_runs?.[service])) ||
        !/^[a-f0-9]{40}$/.test(plan.g6_service_shas?.[service] ?? plan.g6_sha),
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
        '/environments/' +
        destination.githubEnvironment +
        '/variables/AZURE_SUBSCRIPTION_ID',
    ]).value;
    if (
      !uuid.test(subscription) ||
      subscription !== deploymentTargets.subscriptionId
    )
      throw unavailable();
    const runs = new Map();
    const verified = [];
    for (const service of services) {
      const runId = String(plan.g6_cd_runs[service]);
      const sourceSha = plan.g6_service_shas?.[service] ?? plan.g6_sha;
      let runEvidence = runs.get(runId);
      if (!runEvidence) {
        const run = json('gh', [
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
          run.headSha !== sourceSha ||
          run.headBranch !== 'master' ||
          run.event !== 'workflow_dispatch' ||
          typeof run.conclusion !== 'string' ||
          run.url !== 'https://github.com/' + repo + '/actions/runs/' + runId
        )
          throw unavailable();
        runEvidence = { run, workflow };
        runs.set(runId, runEvidence);
      }
      const { run, workflow } = runEvidence;
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
        destination.resourceGroup,
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
        destination.resourceGroup +
        '/providers/Microsoft.App/';
      const appResourceId = resource + 'containerApps/' + service;
      const environmentResourceId =
        resource + 'managedEnvironments/' + destination.acaEnvironment;
      if (
        app.id?.toLowerCase() !== appResourceId.toLowerCase() ||
        app.environment?.toLowerCase() !==
          environmentResourceId.toLowerCase() ||
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
      const serving = active.filter((revision) => revision.traffic > 0);
      if (
        serving.length !== 1 ||
        serving[0].traffic !== 100 ||
        !app.latest ||
        serving[0].name !== app.latest ||
        serving[0].health !== 'Healthy' ||
        serving[0].containers.filter(
          (c) => c.name === service && c.image === image,
        ).length !== 1
      )
        throw unavailable();
      verified.push({
        service,
        destination: plan.g6_destination,
        github_environment: destination.githubEnvironment,
        resource_group: destination.resourceGroup,
        aca_environment: destination.acaEnvironment,
        subscription_id: subscription,
        resource_id: app.id,
        run_id: runId,
        run_url: run.url,
        cd_run_conclusion: run.conclusion,
        deploy_job_conclusion: deploy.conclusion,
        deployment_status: 'VERIFIED_SERVING',
        certification_status:
          run.conclusion === 'success'
            ? 'SUCCESS'
            : 'BLOCKED_CD_RUN_' + run.conclusion.toUpperCase(),
        source_repository: repo,
        source_branch: run.headBranch,
        source_sha: run.headSha,
        source_workflow: workflow.path,
        origin_approved:
          run.headBranch === 'master' &&
          workflow.head_repository?.full_name?.toLowerCase() ===
            repo.toLowerCase(),
        deployed_at: deploy.completedAt,
        revision: serving[0].name,
        effective_traffic_percent: serving[0].traffic,
        image,
        oci_digest: image.slice(prefix.length),
        ...(service === 'api-gateway'
          ? {
              gateway_origin: new URL(plan.gateway).origin,
              gateway_origin_approved: true,
            }
          : {}),
      });
    }
    return verified;
  } catch {
    throw unavailable();
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
