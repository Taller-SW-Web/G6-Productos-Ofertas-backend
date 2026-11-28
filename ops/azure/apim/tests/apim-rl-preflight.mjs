import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEffectiveOperation } from './apim-rl-core.mjs';
import { verifyStagingPermit } from '../../../../scripts/h5/k6/bin/staging-permit.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = (path, code) => {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(code); }
};

function fail(code) { throw new Error(code); }

function getBackendProvenance() {
  try {
    const backendRoot = resolve(here, '../../../../');
    const backendSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: backendRoot, encoding: 'utf8' }).trim();
    if (!/^[a-f0-9]{40}$/i.test(backendSha)) fail('PREFLIGHT_PROCEDENCIA_BACKEND_AUSENTE');
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: backendRoot, encoding: 'utf8' });
    return { backendSha, sourceWorktreeClean: status.trim() === '' };
  } catch {
    fail('PREFLIGHT_PROCEDENCIA_BACKEND_AUSENTE');
  }
}

export function resolveRateLimitRun({ mode, profile, configPath, manifestPath, parametersPath, policyPath, permitPath }) {
  if (!['local', 'remote'].includes(mode)) fail('PREFLIGHT_MODO_INVALIDO');
  if (!['demo-rate-limit', 'aislamiento', 'cuota', 'concurrencia'].includes(profile)) fail('PREFLIGHT_PERFIL_NO_ADMITIDO');
  const config = readJson(configPath, 'PREFLIGHT_CONFIG_INVALIDA');
  const manifestBytes = readFileSync(manifestPath);
  const parametersBytes = readFileSync(parametersPath);
  const policyBytes = readFileSync(policyPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const parameters = JSON.parse(parametersBytes.toString('utf8'));
  const policy = policyBytes.toString('utf8');
  let baseUrl;
  try { baseUrl = new URL(config.base_url); } catch { fail('PREFLIGHT_ORIGEN_INVALIDO'); }
  const remote = mode === 'remote';
  const provenance = getBackendProvenance();
  if (remote && !provenance.sourceWorktreeClean) fail('PREFLIGHT_CODIGO_BACKEND_MODIFICADO');
  if (mode === 'local' && !['127.0.0.1', 'localhost', '[::1]'].includes(baseUrl.hostname)) fail('PREFLIGHT_HOST_NO_AUTORIZADO');
  if (remote && baseUrl.protocol !== 'https:') fail('PREFLIGHT_HOST_NO_AUTORIZADO');

  const selected = {
    operation_id: config.operation_id,
    operation_path: config.operation_path,
    method: config.method,
    rate_profile: config.rate_profile,
    revision: config.revision,
    revision_header: config.revision_header,
    identity: config.identity,
    burst_calls: config.burst_calls,
    burst_window_seconds: config.burst_window_seconds,
    max_requests: config.max_requests,
    max_concurrency: config.max_concurrency,
    max_rps: config.max_rps,
    max_duration_seconds: config.max_duration_seconds,
    max_retry_after_seconds: config.max_retry_after_seconds,
  };
  if (Object.values(selected).some((value) => value === undefined || value === null || value === '')) fail('PREFLIGHT_CONFIG_INCOMPLETA');
  if (config.method !== 'GET' || !config.operation_path.startsWith('/') || /[{}]/.test(config.operation_path)) fail('PREFLIGHT_RUTA_NO_CONCRETA');
  if (config.revision !== parameters.deploymentRevision || sha256(policyBytes) !== config.policy_hash || parameters.policyHash !== config.policy_hash) {
    fail('PREFLIGHT_REVISION_O_POLITICA_EFECTIVA_NO_COINCIDE');
  }

  const requestedProfile = parameters.rateProfiles?.[config.rate_profile];
  if (!requestedProfile || requestedProfile.burstCalls !== config.burst_calls ||
      requestedProfile.burstWindowSeconds !== config.burst_window_seconds) fail('PREFLIGHT_LIMITE_EFECTIVO_NO_COINCIDE');
  let requestBudget;
  let scenarioExpected = {};
  if (profile === 'demo-rate-limit' || profile === 'aislamiento') {
    requestBudget = config.burst_calls + (profile === 'aislamiento' ? 3 : 2);
    if (!Number.isSafeInteger(config.max_requests) || config.max_requests !== requestBudget ||
        !Number.isSafeInteger(config.max_concurrency) || config.max_concurrency !== config.burst_calls ||
        !Number.isSafeInteger(config.max_rps) || config.max_rps !== config.burst_calls ||
        config.max_retry_after_seconds < 1 || config.max_retry_after_seconds > config.burst_window_seconds ||
        config.max_duration_seconds <= config.max_retry_after_seconds + 3) fail('PREFLIGHT_PRESUPUESTO_RATE_LIMIT_INVALIDO');
  } else if (profile === 'cuota') {
    const quotaCalls = requestedProfile.quotaCalls;
    const quotaWindowSeconds = requestedProfile.quotaWindowSeconds;
    const quotaErrorCode = requestedProfile.quotaErrorCode;
    requestBudget = quotaCalls + 1;
    if (!Number.isSafeInteger(quotaCalls) || quotaCalls < 1 || !Number.isSafeInteger(quotaWindowSeconds) ||
        quotaWindowSeconds < 1 || typeof quotaErrorCode !== 'string' || config.quota_calls !== quotaCalls ||
        config.quota_window_seconds !== quotaWindowSeconds || config.quota_error_code !== quotaErrorCode ||
        config.max_requests !== requestBudget || config.max_concurrency !== 1 || config.max_retry_after_seconds !== 0 ||
        !Number.isFinite(config.max_rps) || config.max_rps < requestBudget / quotaWindowSeconds ||
        config.max_rps * config.burst_window_seconds >= config.burst_calls ||
        config.max_duration_seconds < quotaWindowSeconds + 4) fail('PREFLIGHT_PRESUPUESTO_CUOTA_INVALIDO');
    if (remote && quotaWindowSeconds < 300) fail('PREFLIGHT_VENTANA_CUOTA_REMOTA_DEMASIADO_CORTA');
    scenarioExpected = { quotaCalls, quotaWindowSeconds, quotaErrorCode };
  } else {
    const policyConcurrencyLimit = requestedProfile.maxConcurrency;
    const concurrencyCalls = policyConcurrencyLimit + 1;
    requestBudget = concurrencyCalls;
    if (!Number.isSafeInteger(policyConcurrencyLimit) || policyConcurrencyLimit < 1 ||
        config.policy_concurrency_limit !== policyConcurrencyLimit || config.concurrency_calls !== concurrencyCalls ||
        config.max_requests !== requestBudget || config.max_concurrency !== concurrencyCalls ||
        config.max_retry_after_seconds !== 0 || config.burst_calls < concurrencyCalls ||
        config.max_rps !== concurrencyCalls || config.max_duration_seconds <= 3) fail('PREFLIGHT_PRESUPUESTO_CONCURRENCIA_INVALIDO');
    scenarioExpected = { policyConcurrencyLimit, concurrencyCalls };
  }
  if (!Number.isSafeInteger(config.max_duration_seconds) || !Number.isFinite(config.max_rps) ||
      !Number.isSafeInteger(config.max_retry_after_seconds)) fail('PREFLIGHT_PRESUPUESTO_RATE_LIMIT_INVALIDO');

  const expected = {
    origin: baseUrl.origin,
    operationSetSha256: manifest.operationSetSha256,
    filteredOpenApiSha256: manifest.filteredOpenApiCanonicalSha256,
    revision: config.revision,
    policyHash: config.policy_hash,
    operationId: config.operation_id,
    method: 'GET',
    path: config.operation_path,
    rateProfile: config.rate_profile,
    profile,
    burstCalls: config.burst_calls,
    burstWindowSeconds: config.burst_window_seconds,
    maxRequests: config.max_requests,
    maxAuthorizedRequests: config.max_requests,
    requiredRequests: requestBudget,
    scenario: profile,
    maxConcurrency: config.max_concurrency,
    authorizedConcurrency: config.max_concurrency,
    maxVus: profile === 'concurrencia' ? scenarioExpected.concurrencyCalls : 1,
    authorizedVus: profile === 'concurrencia' ? scenarioExpected.concurrencyCalls : 1,
    maxRps: config.max_rps,
    authorizedRps: config.max_rps,
    maxDurationSeconds: config.max_duration_seconds,
    maxRetryAfterSeconds: config.max_retry_after_seconds,
    authorizedDurationSeconds: config.max_duration_seconds,
    ...scenarioExpected,
  };
  const valid = validateEffectiveOperation({ baseUrl: config.base_url, manifest, parameters, expected, remote });
  const policyRule = new RegExp(`<rate-limit-by-key\\b[^>]*calls=["']${config.burst_calls}["'][^>]*renewal-period=["']${config.burst_window_seconds}["']`);
  if (!policyRule.test(policy)) fail('PREFLIGHT_POLITICA_SIN_RATE_LIMIT_EFECTIVO');
  if (profile === 'cuota') {
    const quotaRule = new RegExp(`<quota-by-key\\b[^>]*calls=["']${config.quota_calls}["'][^>]*renewal-period=["']${config.quota_window_seconds}["']`);
    if (!quotaRule.test(policy)) fail('PREFLIGHT_POLITICA_SIN_CUOTA_EFECTIVA');
  }
  if (profile === 'concurrencia' && !new RegExp(`<limit-concurrency\\b[^>]*max-count=["']${config.policy_concurrency_limit}["']`).test(policy)) {
    fail('PREFLIGHT_POLITICA_SIN_CONCURRENCIA_EFECTIVA');
  }
  if (remote && !/^x-[a-z0-9-]{1,62}$/.test(config.revision_header)) fail('PREFLIGHT_CABECERA_REVISION_INVALIDA');

  const result = {
    profile,
    mode,
    backend_sha: provenance.backendSha,
    source_worktree_clean: provenance.sourceWorktreeClean,
    base_url: config.base_url,
    operation_id: valid.operation.operationId,
    operation_path: config.operation_path,
    method: 'GET',
    rate_profile: valid.operation.rateProfile,
    identity: config.identity,
    identity_b: profile === 'aislamiento' ? config.identity_b : null,
    revision: config.revision,
    revision_header: config.revision_header,
    operation_set_sha256: manifest.operationSetSha256,
    filtered_openapi_sha256: manifest.filteredOpenApiCanonicalSha256,
    effective_manifest_sha256: sha256(manifestBytes),
    effective_parameters_sha256: sha256(parametersBytes),
    policy_hash: config.policy_hash,
    burst_calls: config.burst_calls,
    burst_window_seconds: config.burst_window_seconds,
    max_requests: config.max_requests,
    vus: profile === 'concurrencia' ? scenarioExpected.concurrencyCalls : 1,
    max_concurrency: config.max_concurrency,
    max_rps: config.max_rps,
    max_duration_seconds: config.max_duration_seconds,
    max_retry_after_seconds: config.max_retry_after_seconds,
    quota_calls: profile === 'cuota' ? scenarioExpected.quotaCalls : null,
    quota_window_seconds: profile === 'cuota' ? scenarioExpected.quotaWindowSeconds : null,
    quota_error_code: profile === 'cuota' ? scenarioExpected.quotaErrorCode : null,
    policy_concurrency_limit: profile === 'concurrencia' ? scenarioExpected.policyConcurrencyLimit : null,
    concurrency_calls: profile === 'concurrencia' ? scenarioExpected.concurrencyCalls : null,
    request_budget: requestBudget,
    permit_sha256: null,
    verified: true,
  };

  if (remote) {
    const token = process.env.APIM_RL_TEST_TOKEN;
    if (!token) fail('PREFLIGHT_CREDENCIAL_APIM_AUSENTE');
    if (!permitPath) fail('PREFLIGHT_PERMISO_STAGING_AUSENTE');
    const tokenHash = sha256(Buffer.from(token, 'utf8'));
    const backendSha = provenance.backendSha;
    const bindings = {
      environment: 'STAGING_APIM',
      origin: baseUrl.origin,
      method: 'GET',
      case_id: profile === 'aislamiento' ? 'RL-04' : profile === 'demo-rate-limit' ? 'RL-01-RL-03' : profile === 'concurrencia' ? 'RL-06' : 'APIM-QUOTA',
      operation_id: config.operation_id,
      operation_path: config.operation_path,
      channel: config.channel,
      profile,
      vus: profile === 'concurrencia' ? scenarioExpected.concurrencyCalls : 1,
      duration_seconds: config.max_duration_seconds,
      max_rps: config.max_rps,
      max_concurrency: config.max_concurrency,
      max_requests: config.max_requests,
      max_retry_after_seconds: config.max_retry_after_seconds,
      window_start_utc: config.window_start_utc,
      window_end_utc: config.window_end_utc,
      infra_approval_ref: config.infra_approval_ref,
      g7_approval_ref: config.g7_approval_ref,
      revision: config.revision,
      revision_header: config.revision_header,
      backend_sha: backendSha,
      policy_hash: config.policy_hash,
      operation_set_sha256: manifest.operationSetSha256,
      filtered_openapi_sha256: manifest.filteredOpenApiCanonicalSha256,
      effective_manifest_sha256: result.effective_manifest_sha256,
      effective_parameters_sha256: result.effective_parameters_sha256,
      rate_profile: config.rate_profile,
      burst_calls: config.burst_calls,
      burst_window_seconds: config.burst_window_seconds,
      identity: config.identity,
      token_sha256: tokenHash,
      harness_commit: backendSha,
    };
    if (profile === 'aislamiento') {
      const tokenB = process.env.APIM_RL_TEST_TOKEN_B;
      if (!config.identity_b || !tokenB) fail('PREFLIGHT_CREDENCIAL_CLIENTE_B_AUSENTE');
      bindings.identity_b = config.identity_b;
      bindings.token_sha256_b = sha256(Buffer.from(tokenB, 'utf8'));
    } else if (profile === 'cuota') {
      bindings.quota_calls = scenarioExpected.quotaCalls;
      bindings.quota_window_seconds = scenarioExpected.quotaWindowSeconds;
      bindings.quota_error_code = scenarioExpected.quotaErrorCode;
    } else if (profile === 'concurrencia') {
      bindings.policy_concurrency_limit = scenarioExpected.policyConcurrencyLimit;
      bindings.concurrency_calls = scenarioExpected.concurrencyCalls;
    }
    const authorities = readJson(resolve(here, '../../../../scripts/h5/k6/config/staging-authorities.json'), 'PREFLIGHT_AUTORIDADES_INVALIDAS');
    const envelope = readJson(permitPath, 'PREFLIGHT_PERMISO_FORMATO');
    const verified = verifyStagingPermit(envelope, bindings, authorities);
    result.permit_sha256 = verified.permit_sha256;
  } else if (remote) {
    fail('PREFLIGHT_HOST_NO_AUTORIZADO');
  } else if (manifest.fixtureType !== 'LOCAL_SIMULATION') {
    fail('PREFLIGHT_SIMULACION_NO_IDENTIFICADA');
  }

  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, profile, configPath, manifestPath, parametersPath, policyPath, permitPath] = process.argv.slice(2);
    const result = resolveRateLimitRun({ mode, profile, configPath, manifestPath, parametersPath, policyPath, permitPath });
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    process.stderr.write(`${/^PREFLIGHT_[A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'PREFLIGHT_RATE_LIMIT_CONFIG_INVALIDA'}\n`);
    process.exitCode = 2;
  }
}
