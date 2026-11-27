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
const scenarios = JSON.parse(
  readFileSync(new URL('./escenarios.json', import.meta.url), 'utf8'),
);
const scenarioServices = {
  'G5-H5-01': { reserve: ['api-gateway', 'inventory-svc'] },
  'G5-H5-02': { reserve: ['api-gateway', 'inventory-svc'] },
  'G5-H5-03': { confirm: ['api-gateway', 'inventory-svc'] },
  'G5-H5-04': { cancel: ['api-gateway', 'inventory-svc'] },
  'G5-H5-05': {
    coupon: ['api-gateway', 'promotions-svc', 'inventory-svc', 'catalog-svc'],
  },
  'G5-H5-06': { cancel: ['api-gateway', 'promotions-svc', 'inventory-svc'] },
  'G5-H5-07': { follow: ['api-gateway'] },
  'G5-H5-08': {
    coupon: ['api-gateway', 'promotions-svc', 'inventory-svc', 'catalog-svc'],
  },
  'G5-H5-09': { follow: ['api-gateway'] },
  'G5-H5-10': { expired: ['api-gateway', 'inventory-svc'] },
  'G5-H5-11': { expired: ['api-gateway', 'inventory-svc'] },
  'G5-H5-12': { follow: ['api-gateway', 'inventory-svc'] },
  'G5-H5-13': { auth: ['api-gateway', 'promotions-svc'] },
  'G5-H5-14': { auth: ['api-gateway', 'promotions-svc'] },
  'G5-H5-15': { follow: ['api-gateway', 'promotions-svc'] },
  'G5-H5-16': { follow: ['api-gateway', 'promotions-svc'] },
  'G5-H5-19': { follow: ['api-gateway', 'inventory-svc'] },
};
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const digest = /^sha256:[0-9a-f]{64}$/;
const unavailable = () => new Error('DESPLIEGUE_OFICIAL_NO_VERIFICADO');
export function requiredDeploymentServices(plan, action) {
  const scenario = scenarios.find((entry) => entry.id === plan.case_id);
  const selectedAction = action ?? scenario?.stage;
  if (!scenario) throw unavailable();
  if (!selectedAction && scenario.stage === null) return [];
  if (!selectedAction || scenario.stage !== selectedAction) throw unavailable();
  const baseRequired = scenarioServices[scenario.id]?.[selectedAction];
  if (!baseRequired) throw unavailable();
  const required = [...baseRequired];
  if (['G5-H5-07', 'G5-H5-09'].includes(scenario.id)) {
    const service =
      plan.follow_type === 'cupones'
        ? 'promotions-svc'
        : plan.follow_type === 'inventario'
          ? 'inventory-svc'
          : undefined;
    if (!service) throw unavailable();
    required.push(service);
  }
  if (
    ['G5-H5-12', 'G5-H5-19'].includes(scenario.id) &&
    plan.follow_type === 'cupones'
  )
    required.push('promotions-svc');
  else if (
    ['G5-H5-12', 'G5-H5-19'].includes(scenario.id) &&
    plan.follow_type !== 'inventario'
  )
    throw unavailable();
  return services.filter((service) => required.includes(service));
}
const exec = (command, args) =>
  execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20_000,
  });

export async function verificarDespliegue(
  plan,
  actionOrExecute = undefined,
  executeOverride = exec,
) {
  const action =
    typeof actionOrExecute === 'string'
      ? actionOrExecute
      : scenarios.find((entry) => entry.id === plan.case_id)?.stage;
  const execute =
    typeof actionOrExecute === 'function' ? actionOrExecute : executeOverride;
  const requiredServices = requiredDeploymentServices(plan, action);
  const gatewayRouteProfile = plan.gateway_route_profile ?? 'standard';
  const destination = deploymentTargets.destinations?.[plan.g6_destination];
  if (
    plan.environment !== 'integration' ||
    !/^[a-f0-9]{40}$/.test(plan.g6_sha) ||
    !destination ||
    !['brazil-isolated', 'chile-shared'].includes(plan.g6_destination) ||
    !['standard', 'g5-labelled'].includes(gatewayRouteProfile) ||
    (gatewayRouteProfile === 'g5-labelled' &&
      (plan.g6_destination !== 'chile-shared' ||
        !/^api-gateway---g5-h5\.[a-z0-9-]+\.chilecentral\.azurecontainerapps\.io$/i.test(
          new URL(plan.gateway).hostname,
        ))) ||
    (plan.g6_service_shas !== undefined &&
      (typeof plan.g6_service_shas !== 'object' ||
        Array.isArray(plan.g6_service_shas) ||
        Object.keys(plan.g6_service_shas).some(
          (service) =>
            !services.includes(service) ||
            !/^[a-f0-9]{40}$/.test(plan.g6_service_shas[service]),
        ))) ||
    !plan.g6_cd_runs ||
    typeof plan.g6_cd_runs !== 'object' ||
    Array.isArray(plan.g6_cd_runs) ||
    Object.entries(plan.g6_cd_runs).some(
      ([service, runId]) =>
        !services.includes(service) ||
        !/^[1-9][0-9]{0,15}$/.test(String(runId)),
    ) ||
    requiredServices.some(
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
    for (const service of requiredServices) {
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
      const deploy = (Array.isArray(run.jobs) ? run.jobs : []).find(
        (job) => job.name === 'Desplegar ' + service + ' en Azure',
      );
      const prefix = 'ghcr.io/' + repo.toLowerCase() + '/' + service + '@';
      let cdImage;
      try {
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
        cdImage = (
          await readFile(join(temp, 'image-' + service + '.txt'), 'utf8')
        ).trim();
      } catch {
        cdImage = undefined;
      }
      const cdArtifactValid =
        typeof cdImage === 'string' &&
        cdImage.startsWith(prefix) &&
        digest.test(cdImage.slice(prefix.length));

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
        '{id:id,environment:properties.environmentId || properties.managedEnvironmentId,latest:properties.latestReadyRevisionName,host:properties.configuration.ingress.fqdn,mode:properties.configuration.activeRevisionsMode,traffic:properties.configuration.ingress.traffic}',
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
      const expectedGatewayHost =
        service === 'api-gateway' && gatewayRouteProfile === 'g5-labelled'
          ? app.host?.replace(/^api-gateway\./, 'api-gateway---g5-h5.')
          : app.host;
      if (
        app.id?.toLowerCase() !== appResourceId.toLowerCase() ||
        app.environment?.toLowerCase() !==
          environmentResourceId.toLowerCase() ||
        (service === 'api-gateway' &&
          new URL(plan.gateway).origin !== 'https://' + expectedGatewayHost)
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
      let serving;
      const effectiveTraffic = 100;
      let routeEvidence;
      if (service === 'api-gateway' && gatewayRouteProfile === 'g5-labelled') {
        const labelRoutes = (app.traffic ?? []).filter(
          (route) => route.label === 'g5-h5',
        );
        const defaultRoutes = (app.traffic ?? []).filter(
          (route) => !route.label,
        );
        if (
          app.mode !== 'Multiple' ||
          labelRoutes.length !== 1 ||
          !labelRoutes[0].revisionName ||
          labelRoutes[0].revisionName !== app.latest ||
          defaultRoutes.length !== 1 ||
          defaultRoutes[0].weight !== 100 ||
          !defaultRoutes[0].revisionName ||
          defaultRoutes[0].revisionName === labelRoutes[0].revisionName
        )
          throw unavailable();
        serving = active.find(
          (revision) => revision.name === labelRoutes[0].revisionName,
        );
        const marketplace = active.find(
          (revision) => revision.name === defaultRoutes[0].revisionName,
        );
        if (
          !serving ||
          serving.health !== 'Healthy' ||
          !marketplace ||
          marketplace.health !== 'Healthy'
        )
          throw unavailable();
        routeEvidence = {
          route_mode: 'revision_label',
          traffic_scope: 'label_url',
          label: 'g5-h5',
          label_url: plan.gateway,
          marketplace_revision: marketplace.name,
          marketplace_traffic_percent: defaultRoutes[0].weight,
        };
      } else {
        const defaultServing = active.filter(
          (revision) => revision.traffic > 0,
        );
        if (
          defaultServing.length !== 1 ||
          defaultServing[0].traffic !== 100 ||
          defaultServing[0].health !== 'Healthy' ||
          (service === 'api-gateway' &&
            (!app.latest || defaultServing[0].name !== app.latest))
        )
          throw unavailable();
        serving = defaultServing[0];
      }
      const serviceContainers = serving.containers.filter(
        (container) => container.name === service,
      );
      const image = serviceContainers[0]?.image;
      if (
        !image?.startsWith(prefix) ||
        serviceContainers.length !== 1 ||
        !digest.test(image.slice(prefix.length))
      )
        throw unavailable();
      const deployJobConclusion = deploy?.conclusion ?? null;
      const completedAt = deploy?.completedAt;
      const originApproved =
        run.headBranch === 'master' &&
        workflow.head_repository?.full_name?.toLowerCase() ===
          repo.toLowerCase();
      const provenanceMatchesServing = cdArtifactValid && cdImage === image;
      const certificationStatus =
        run.conclusion === 'success' &&
        deployJobConclusion === 'success' &&
        Number.isFinite(Date.parse(completedAt)) &&
        originApproved &&
        provenanceMatchesServing
          ? 'SUCCESS'
          : run.conclusion !== 'success'
            ? 'BLOCKED_CD_RUN_' + run.conclusion.toUpperCase()
            : deployJobConclusion !== 'success'
              ? 'BLOCKED_DEPLOY_JOB_' +
                (deployJobConclusion ?? 'MISSING').toUpperCase()
              : cdArtifactValid && cdImage !== image
                ? 'BLOCKED_DIGEST_MISMATCH'
                : 'BLOCKED_CD_EVIDENCE_INSUFFICIENT';
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
        deploy_job_conclusion: deployJobConclusion,
        deployment_status: 'VERIFIED_SERVING',
        certification_status: certificationStatus,
        provenance_matches_serving: provenanceMatchesServing,
        source_repository: repo,
        source_branch: run.headBranch,
        source_sha: run.headSha,
        source_workflow: workflow.path,
        origin_approved: originApproved,
        deployed_at: Number.isFinite(Date.parse(completedAt))
          ? completedAt
          : null,
        revision: serving.name,
        effective_traffic_percent: effectiveTraffic,
        image,
        oci_digest: image.slice(prefix.length),
        ...(service === 'api-gateway'
          ? {
              gateway_origin: new URL(plan.gateway).origin,
              gateway_origin_approved: true,
              ...(routeEvidence ?? { route_mode: 'default_traffic' }),
            }
          : {}),
      });
    }
    return verified;
  } catch (error) {
    if (process.env.DEBUG_G6_H5_DEPLOYMENT === 'true') console.error(error);
    throw unavailable();
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
