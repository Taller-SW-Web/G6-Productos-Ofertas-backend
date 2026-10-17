import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';

const cwd = await mkdtemp(join(tmpdir(), 'gateway-readiness-'));
const cli = resolve('dist/apps/api-gateway/readiness.js');
let reply = { status: 200, body: '{"status":"ready"}', delay: 0 };
const paths = [];
const provider = createServer(async (req, res) => {
  paths.push(req.url);
  if (reply.delay) await new Promise((done) => setTimeout(done, reply.delay));
  res.writeHead(reply.status, { 'content-type': 'application/json' });
  res.end(reply.body);
});
let gatewayLive = true;
let gatewayPort;
const gateway = createServer((req, res) => {
  assert.equal(req.url, '/health');
  res.writeHead(gatewayLive ? 200 : 503, {
    'content-type': 'application/json',
  });
  res.end(
    JSON.stringify({
      service: 'api-gateway',
      status: gatewayLive ? 'ok' : 'down',
    }),
  );
});
async function run(environment = {}) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith('GATEWAY_') && !name.startsWith('AUTH_'),
    ),
  );
  Object.assign(env, { API_GATEWAY_PORT: String(gatewayPort) }, environment);
  const child = spawn(process.execPath, [cli], {
    cwd,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let errors = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    errors += chunk;
  });
  const deadline = setTimeout(() => child.kill(), 10000);
  try {
    const [code] = await once(child, 'exit');
    assert.equal(errors, '');
    const result = JSON.parse(output);
    assert.doesNotMatch(output, /127\.0\.0\.1|private-secret|http:/);
    return { code, result };
  } finally {
    clearTimeout(deadline);
  }
}
try {
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  const gatewayAddress = gateway.address();
  assert.ok(gatewayAddress && typeof gatewayAddress !== 'string');
  gatewayPort = gatewayAddress.port;
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const address = provider.address();
  assert.ok(address && typeof address !== 'string');
  const env = {
    GATEWAY_CATALOG_SVC_URL: `http://127.0.0.1:${address.port}`,
    GATEWAY_CATALOG_SVC_READINESS_PATH: '/health/ready',
    GATEWAY_TIMEOUT_MS: '1000',
  };
  assert.equal((await run()).code, 1);
  const unverified = await run({
    GATEWAY_CATALOG_SVC_URL: env.GATEWAY_CATALOG_SVC_URL,
  });
  assert.equal(unverified.result.dependencies['catalog-svc'], 'unverified');
  assert.deepEqual(paths, []);
  const ready = await run(env);
  assert.equal(ready.code, 0);
  assert.equal(ready.result.status, 'ready');
  assert.equal(ready.result.coverage, 'partial');
  gatewayLive = false;
  const down = await run(env);
  assert.equal(down.code, 1);
  assert.equal(down.result.gateway, 'not_live');
  gatewayLive = true;
  reply = { status: 200, body: '{"status":"ok"}', delay: 0 };
  assert.equal((await run(env)).code, 1);
  reply.status = 404;
  assert.equal((await run(env)).code, 1);
  reply = { status: 503, body: '{"status":"not_ready"}', delay: 0 };
  assert.equal((await run(env)).code, 1);
  reply = { status: 200, body: '{"status":"ready"}', delay: 2000 };
  assert.equal((await run(env)).code, 1);
  const invalid = await run({
    ...env,
    GATEWAY_CATALOG_SVC_READINESS_PATH: '/health?private-secret',
  });
  assert.equal(invalid.code, 1);
  assert.equal(invalid.result.code, 'INVALID_READINESS_CONFIGURATION');
  assert.ok(paths.every((path) => path === '/health/ready'));
  console.log(
    'PASS: readiness CLI exit codes, partial deployment, unavailable/unverified/liveness-only dependencies, timeout and safe output. Isolated HTTP provider only.',
  );
} finally {
  gateway.closeAllConnections();
  await new Promise((done) => gateway.close(done));
  provider.closeAllConnections();
  await new Promise((done) => provider.close(done));
  await rm(cwd, { recursive: true, force: true });
}
