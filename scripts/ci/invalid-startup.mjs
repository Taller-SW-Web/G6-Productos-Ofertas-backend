import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
// No heredar conexiones privadas de la máquina que ejecuta el smoke.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PG|G6_|DATABASE_URL)/i.test(key)));
for (const service of ['catalog', 'taxonomy']) {
  const result = spawnSync(process.execPath, [`dist/apps/${service}-svc/main.js`], { env, encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(result.error, undefined, 'El proceso debe terminar dentro del plazo');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /APPLICATION_START_FAILED/);
  assert.doesNotMatch(result.stdout + result.stderr, /postgres(?:ql)?:\/\/|password|SELECT /i);
  console.log(`PASS: ${service} rechaza configuración ausente; no acredita arranque positivo`);
}
