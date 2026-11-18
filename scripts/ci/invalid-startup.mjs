import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
// No heredar conexiones privadas de la máquina que ejecuta el smoke.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PG|G6_|DATABASE_URL)/i.test(key)));
for (const service of ['catalog', 'taxonomy']) {
  const image = `g6-service:${service}-svc-ci`;
  const result = spawnSync('docker', ['run', '--rm', image], { env, encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(result.error, undefined, 'El proceso debe terminar dentro del plazo');
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /APPLICATION_START_FAILED/);
  assert.doesNotMatch(result.stdout + result.stderr, /postgres(?:ql)?:\/\/|password|SELECT /i);
  console.log(`PASS: la imagen ${image} rechaza configuración ausente; no acredita arranque positivo`);
}
