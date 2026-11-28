import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { resolveRateLimitRun } from './apim-rl-preflight.mjs';

const repo = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const runner = join(repo, 'scripts/h5/k6/bin/ejecutar-rate-limit.ps1');
const k6Path = 'C:\\Program Files\\k6\\k6.exe';
const artifactRoot = join(repo, 'scripts/h5/k6/.local/apim-rate-limit');
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const powershellCandidates = process.platform === 'win32' ? ['pwsh.exe', 'powershell.exe'] : ['pwsh'];
const powershell = powershellCandidates.find((executable) => {
  const probe = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
    windowsHide: true,
    stdio: 'ignore',
  });
  return !probe.error && probe.status === 0;
});
if (!powershell) throw new Error('POWERSHELL_NO_DISPONIBLE');

function servePolicy(mode, profile = 'demo-rate-limit') {
  const seen = new Map();
  const requests = [];
  const server = createServer((req, res) => {
    const correlationId = req.headers['x-correlation-id'] || '';
    const identity = req.headers.authorization || 'missing';
    requests.push({ identity, correlationId, time: Date.now() });
    res.setHeader('x-fixture-revision', 'REV-LOCAL');
    res.setHeader('x-correlation-id', correlationId);
    if (mode === 'http-401' || mode === 'http-403' || mode === 'http-5xx') {
      const status = mode === 'http-401' ? 401 : mode === 'http-403' ? 403 : 503;
      res.statusCode = status;
      res.end(status === 403 ? JSON.stringify({ status, code: 'SCOPE_INSUFICIENTE' }) : 'fixture');
      return;
    }
    if (mode === 'no-429') {
      res.statusCode = 200;
      res.end('{}');
      return;
    }
    if (profile === 'cuota') {
      const state = seen.get(identity) || { count: 0 };
      state.count += 1;
      seen.set(identity, state);
      if (state.count <= 4) {
        res.statusCode = 200;
        res.end('{}');
      } else {
        res.statusCode = 403;
        const code = mode === 'wrong-quota-code' ? 'SCOPE_INSUFICIENTE' : 'RATE_LIMIT_CUOTA';
        res.end(JSON.stringify({ status: 403, code }));
      }
      return;
    }
    if (profile === 'concurrencia') {
      const state = seen.get(identity) || { inFlight: 0 };
      state.inFlight += 1;
      seen.set(identity, state);
      if (state.inFlight > 2) {
        state.inFlight -= 1;
        res.statusCode = 429;
        res.setHeader('Retry-After', '1');
        res.end(JSON.stringify({ status: 429, code: 'CONCURRENCIA_EXCEDIDA' }));
      } else {
        setTimeout(() => {
          state.inFlight -= 1;
          res.statusCode = 200;
          res.end('{}');
        }, 1200);
      }
      return;
    }
    const state = seen.get(identity) || { opened: Date.now(), count: 0, blocked: false };
    if (mode !== 'no-recovery' && Date.now() - state.opened >= 1000) {
      state.opened = Date.now();
      state.count = 0;
      state.blocked = false;
    }
    state.count += 1;
    if (state.count <= 2 && !state.blocked) {
      res.statusCode = 200;
      res.end('{}');
    } else {
      state.blocked = true;
      res.statusCode = 429;
      if (mode !== 'no-retry-after') res.setHeader('Retry-After', '1');
      res.end(JSON.stringify({ status: 429, code: 'RATE_LIMIT_EXCEDIDO' }));
    }
    seen.set(identity, state);
  });
  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolveListen({ server, requests, baseUrl: `http://127.0.0.1:${address.port}/api/v1` });
    });
  });
}

function fixtureFiles(baseUrl, profile = 'demo-rate-limit', overrides = {}) {
  const temp = mkdtempSync(join(os.tmpdir(), 'apim-rl-local-'));
  const burstCalls = profile === 'cuota' ? 10 : profile === 'concurrencia' ? 3 : 2;
  const quotaCalls = profile === 'cuota' ? 4 : 4;
  const quotaWindowSeconds = profile === 'cuota' ? 2 : 300;
  const policy = `<policies><inbound><rate-limit-by-key calls="${burstCalls}" renewal-period="1" />${profile === 'cuota' ? `<quota-by-key calls="${quotaCalls}" renewal-period="${quotaWindowSeconds}" />` : ''}${profile === 'concurrencia' ? '<limit-concurrency max-count="2"></limit-concurrency>' : ''}</inbound></policies>\n`;
  const operationId = 'listarProductos';
  const operationSetSha256 = 'a'.repeat(64);
  const openApiSha256 = 'b'.repeat(64);
  const parameters = {
    expectedOperationSetSha256: operationSetSha256,
    expectedFilteredOpenApiSha256: openApiSha256,
    deploymentRevision: 'REV-LOCAL',
    policyHash: sha256(Buffer.from(policy)),
    rateProfiles: {
      commercial_read: {
        burstCalls, burstWindowSeconds: 1, quotaCalls, quotaWindowSeconds,
        quotaErrorCode: profile === 'cuota' ? 'RATE_LIMIT_CUOTA' : undefined,
        maxConcurrency: profile === 'concurrencia' ? 2 : 0,
      },
    },
  };
  const manifest = {
    fixtureType: 'LOCAL_SIMULATION',
    publicationMode: 'effective',
    operationSetSha256,
    filteredOpenApiCanonicalSha256: openApiSha256,
    effectivePublication: { authorized: true, publishedOperationIds: [operationId] },
    operations: [{ operationId, method: 'GET', path: '/productos', rateProfile: 'commercial_read', environmentEnabled: true }],
  };
  const config = {
    base_url: baseUrl,
    channel: 'MARKETPLACE',
    operation_id: operationId,
    method: 'GET',
    operation_path: '/productos',
    rate_profile: 'commercial_read',
    identity: 'consumer-a',
    identity_b: 'consumer-b',
    revision: 'REV-LOCAL',
    revision_header: 'x-fixture-revision',
    policy_hash: parameters.policyHash,
    burst_calls: burstCalls,
    burst_window_seconds: 1,
    max_requests: profile === 'aislamiento' ? 5 : profile === 'cuota' ? 5 : profile === 'concurrencia' ? 3 : 4,
    max_concurrency: profile === 'cuota' ? 1 : profile === 'concurrencia' ? 3 : 2,
    max_rps: profile === 'cuota' ? 3 : profile === 'concurrencia' ? 3 : 2,
    max_duration_seconds: 8,
    max_retry_after_seconds: profile === 'cuota' || profile === 'concurrencia' ? 0 : 1,
    ...(profile === 'cuota' ? { quota_calls: quotaCalls, quota_window_seconds: quotaWindowSeconds, quota_error_code: 'RATE_LIMIT_CUOTA' } : {}),
    ...(profile === 'concurrencia' ? { policy_concurrency_limit: 2, concurrency_calls: 3 } : {}),
    ...overrides,
  };
  mkdirSync(temp, { recursive: true });
  const files = {
    config: join(temp, 'config.json'),
    manifest: join(temp, 'manifest.json'),
    parameters: join(temp, 'parameters.json'),
    policy: join(temp, 'policy.xml'),
    temp,
  };
  writeFileSync(files.config, JSON.stringify(config));
  writeFileSync(files.manifest, JSON.stringify(manifest));
  writeFileSync(files.parameters, JSON.stringify(parameters));
  writeFileSync(files.policy, policy);
  return files;
}

function callRunner({ profile = 'demo-rate-limit', files, validate = false }) {
  const args = [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', runner,
    '-Profile', profile, '-Mode', 'local', '-Config', files.config,
    '-Manifest', files.manifest, '-Parameters', files.parameters, '-Policy', files.policy,
    '-K6Path', k6Path,
  ];
  if (validate) args.push('-SoloValidar');
  return new Promise((resolveRun, reject) => {
    const child = spawn(powershell, args, { cwd: repo, windowsHide: true, env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolveRun({ code, stdout, stderr }));
  });
}

function readRunSummary(output, diagnostic = '') {
  const match = output.match(/\.local[\\/]apim-rate-limit[\\/]([0-9a-f]{32})[\\/]summary\.json/);
  assert.ok(match, `runner did not return a summary path: ${output} ${diagnostic}`);
  const summary = JSON.parse(readFileSync(join(artifactRoot, match[1], 'summary.json'), 'utf8'));
  summary._evidenceDir = join(artifactRoot, match[1]);
  return summary;
}

async function runCase(mode, profile = 'demo-rate-limit', overrides = {}, validate = false) {
  const lab = await servePolicy(mode, profile);
  const files = fixtureFiles(lab.baseUrl, profile, overrides);
  try {
    const result = await callRunner({ profile, files, validate });
    return { ...result, summary: readRunSummary(result.stdout, result.stderr), requests: lab.requests };
  } finally {
    await new Promise((resolveClose) => lab.server.close(resolveClose));
    const target = resolve(files.temp);
    const tempRoot = resolve(os.tmpdir()) + '\\';
    if (target.startsWith(tempRoot)) rmSync(target, { recursive: true, force: true });
  }
}

test('la simulación local ejecuta normal → 429/Retry-After → espera → recuperación y exporta evidencias', async () => {
  const run = await runCase('normal');
  assert.equal(run.code, 0, `${run.stderr}${run.stdout}; backend requests=${run.requests.length}`);
  assert.equal(run.summary.environment, 'L1_LOCAL_POLICY_SIMULATION');
  assert.equal(run.summary.status, 'PASS');
  assert.equal(run.summary.demo_event.requirements['RL-01'], 'PASS');
  assert.equal(run.summary.demo_event.requirements['RL-02'], 'PASS');
  assert.equal(run.summary.demo_event.result.normal_and_burst_within_effective_window, true);
  assert.ok(run.summary.demo_event.result.burst_duration_seconds <= 1);
  assert.equal(run.summary.demo_event.result.retry_after_seconds, 1);
  assert.ok(run.summary.demo_event.result.actual_wait_seconds >= 1);
  assert.equal(run.summary.demo_event.result.recovery_status, 200);
  assert.equal(run.summary.demo_event.result.client_requests_during_wait, 0);
  assert.equal(run.requests.length, 4);
  assert.ok(run.requests.at(-1).time - run.requests[2].time >= 900,
    'the same consumer must remain silent for the observed Retry-After interval');
  assert.equal(run.summary.k6_summary.metrics.unexpected?.count ?? 0, 0);
  assert.ok(Number.isFinite(run.summary.latency_ms.p95));
  assert.ok(Number.isFinite(run.summary.latency_ms.p99));
  assert.ok(existsSync(join(run.summary._evidenceDir, 'dashboard.html')));
  assert.ok(existsSync(join(run.summary._evidenceDir, 'evidence-index.json')));
  assert.ok(existsSync(join(run.summary._evidenceDir, 'evidence-index.sha256')));
  const indexPath = join(run.summary._evidenceDir, 'evidence-index.json');
  const indexHash = readFileSync(join(run.summary._evidenceDir, 'evidence-index.sha256'), 'utf8').split(/\s+/)[0];
  assert.equal(indexHash, sha256(readFileSync(indexPath)));
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  assert.ok(index.artifacts.some((artifact) => artifact.file === 'dashboard.html'));
});

test('el perfil de aislamiento limita a A y admite a B antes de la recuperación de A', async () => {
  const run = await runCase('normal', 'aislamiento');
  assert.equal(run.code, 0, run.stderr + run.stdout);
  assert.equal(run.summary.status, 'PASS');
  assert.equal(run.summary.demo_event.requirements['RL-04'], 'PASS');
  assert.equal(run.summary.demo_event.result.consumer_b_status, 200);
  assert.equal(run.requests.length, 5);
});

test('el perfil de cuota exige presupuesto y código HTTP 403 respaldados por la política efectiva', async () => {
  const run = await runCase('normal', 'cuota');
  assert.equal(run.code, 0, run.stderr + run.stdout);
  assert.equal(run.summary.status, 'PASS');
  assert.equal(run.summary.demo_event.result.requests_offered, 5);
  assert.equal(run.summary.demo_event.result.requests_admitted, 4);
  assert.equal(run.summary.demo_event.result.requests_rejected, 1);
  assert.equal(run.summary.demo_event.result.expected_http_403_code, 'RATE_LIMIT_CUOTA');
  assert.equal(run.requests.length, 5);
  assert.ok(run.requests.at(-1).time - run.requests[0].time >= 1500);
});

test('un HTTP 403 con código distinto del contrato efectivo no se acredita como cuota', async () => {
  const run = await runCase('wrong-quota-code', 'cuota');
  assert.notEqual(run.code, 0);
  assert.equal(run.summary.status, 'FAIL');
  assert.equal(run.summary.demo_event.result.requests_rejected, 0);
  assert.ok(run.summary.k6_summary.metrics.status_403.count > 0);
  assert.ok(run.summary.k6_summary.metrics.unexpected.count > 0);
});

test('el perfil de concurrencia registra el bloqueo y deja RL-06 inconcluso sin evidencia de idempotencia', async () => {
  const run = await runCase('normal', 'concurrencia');
  assert.equal(run.code, 0, run.stderr + run.stdout);
  assert.equal(run.summary.status, 'PASS');
  assert.equal(run.summary.demo_event.requirements['RL-06'], 'INCONCLUSIVE_IDEMPOTENCIA_NO_VERIFICADA');
  assert.ok(run.summary.demo_event.result.requests_rejected_429 > 0);
  assert.equal(run.summary.demo_event.result.requests_offered, 3);
  assert.equal(run.requests.length, 3);
});

test('las negativas detectan ausencia de 429, Retry-After, recuperación y estados inesperados', async (t) => {
  for (const [mode, expectedStatus] of [
    ['no-429', null], ['no-retry-after', null], ['no-recovery', null],
    ['http-401', 401], ['http-403', 403], ['http-5xx', 503],
  ]) {
    await t.test(mode, async () => {
      const run = await runCase(mode);
      assert.notEqual(run.code, 0);
      assert.equal(run.summary.status, 'FAIL');
      if (mode === 'no-429') assert.equal(run.summary.demo_event.result.rejected_429, 0);
      if (mode === 'no-retry-after') assert.equal(run.summary.demo_event.result.retry_after_seconds, null);
      if (mode === 'no-recovery') assert.equal(run.summary.demo_event.result.recovery_status, 429);
      if (expectedStatus) {
        const field = expectedStatus === 401 ? 'status_401' : expectedStatus === 403 ? 'status_403' : 'status_5xx';
        assert.ok(run.summary.k6_summary.metrics[field].count > 0);
        assert.ok(run.summary.k6_summary.metrics.unexpected.count > 0);
      }
    });
  }
});

test('preflight sin tráfico rechaza un presupuesto distinto al bloque firmado/efectivo', async () => {
  const lab = await servePolicy('normal');
  const files = fixtureFiles(lab.baseUrl, 'demo-rate-limit', { max_requests: 7 });
  try {
    const result = await callRunner({ files, validate: true });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /PREFLIGHT_PRESUPUESTO_RATE_LIMIT_INVALIDO/);
    assert.equal(lab.requests.length, 0);
  } finally {
    await new Promise((resolveClose) => lab.server.close(resolveClose));
    const target = resolve(files.temp);
    const tempRoot = resolve(os.tmpdir()) + '\\';
    if (target.startsWith(tempRoot)) rmSync(target, { recursive: true, force: true });
  }
});

test('preflight sin tráfico produce resumen e índice con SHA-256 y no envía solicitudes', async () => {
  const lab = await servePolicy('normal');
  const files = fixtureFiles(lab.baseUrl);
  try {
    const result = await callRunner({ files, validate: true });
    assert.equal(result.code, 0, result.stderr + result.stdout);
    const summary = readRunSummary(result.stdout, result.stderr);
    assert.equal(summary.status, 'NOT_RUN');
    assert.match(summary.exact_command, /-SoloValidar/);
    assert.equal(lab.requests.length, 0);
    const indexPath = join(summary._evidenceDir, 'evidence-index.json');
    const indexHash = readFileSync(join(summary._evidenceDir, 'evidence-index.sha256'), 'utf8').split(/\s+/)[0];
    assert.equal(indexHash, sha256(readFileSync(indexPath)));
  } finally {
    await new Promise((resolveClose) => lab.server.close(resolveClose));
    const target = resolve(files.temp);
    const tempRoot = resolve(os.tmpdir()) + '\\';
    if (target.startsWith(tempRoot)) rmSync(target, { recursive: true, force: true });
  }
});

test('preflight sin tráfico rechaza código de cuota no respaldado por parámetros efectivos', async () => {
  const lab = await servePolicy('normal', 'cuota');
  const files = fixtureFiles(lab.baseUrl, 'cuota', { quota_error_code: 'SCOPE_INSUFICIENTE' });
  try {
    const result = await callRunner({ profile: 'cuota', files, validate: true });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /PREFLIGHT_PRESUPUESTO_CUOTA_INVALIDO/);
    assert.equal(lab.requests.length, 0);
  } finally {
    await new Promise((resolveClose) => lab.server.close(resolveClose));
    const target = resolve(files.temp);
    const tempRoot = resolve(os.tmpdir()) + '\\';
    if (target.startsWith(tempRoot)) rmSync(target, { recursive: true, force: true });
  }
});

test('preflight remoto rechaza la ejecución si no recibe una credencial para validar contra el permiso firmado', () => {
  const files = fixtureFiles('https://apim.example.invalid/api/v1');
  const manifest = JSON.parse(readFileSync(files.manifest, 'utf8'));
  delete manifest.fixtureType;
  writeFileSync(files.manifest, JSON.stringify(manifest));
  const previousToken = process.env.APIM_RL_TEST_TOKEN;
  delete process.env.APIM_RL_TEST_TOKEN;
  try {
    assert.throws(() => resolveRateLimitRun({
      mode: 'remote', profile: 'demo-rate-limit', configPath: files.config,
      manifestPath: files.manifest, parametersPath: files.parameters, policyPath: files.policy,
    }), /CREDENCIAL_APIM_AUSENTE/);
  } finally {
    if (previousToken === undefined) delete process.env.APIM_RL_TEST_TOKEN;
    else process.env.APIM_RL_TEST_TOKEN = previousToken;
    const target = resolve(files.temp);
    const tempRoot = resolve(os.tmpdir()) + '\\';
    if (target.startsWith(tempRoot)) rmSync(target, { recursive: true, force: true });
  }
});
