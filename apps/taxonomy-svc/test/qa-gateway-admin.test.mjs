import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(
  new URL('./qa-gateway-admin.mjs', import.meta.url),
);
const makeToken = (sub) =>
  `${Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.signature`;
const gestor = makeToken('gestor');
const low = makeToken('limited');

for (const scenario of [
  { includeLow: true, failures: false },
  { includeLow: false, failures: false },
  { includeLow: false, failures: true },
  { includeLow: false, failures: true, creationFails: true },
]) {
  const { includeLow, failures, creationFails = false } = scenario;
  test(`ejecutor con 403 ${includeLow ? 'probado' : 'pendiente'}, fallos previos ${failures}, creación fallida ${creationFails}`, () => {
    const fake = `
const gestor = ${JSON.stringify(gestor)};
const low = ${JSON.stringify(low)};
const ids = { categorias: '11111111-1111-4111-8111-111111111111', marcas: '33333333-3333-4333-8333-333333333333', caracteristicas: '44444444-4444-4444-8444-444444444444' };
const operation = '22222222-2222-4222-8222-222222222222';
const inactive = new Set();
const timeout = AbortSignal.timeout;
AbortSignal.timeout = (ms) => { if (ms !== 45000) throw new Error('timeout inesperado'); return timeout(ms); };
globalThis.fetch = async (url, init) => {
  const path = new URL(url).pathname.replace('/api/v1', '');
  const auth = init.headers.Authorization;
  if (!auth && init.method === 'GET') return Response.json({items:[]}, {status:200});
  if (!auth) return Response.json({code:'TOKEN_INVALIDO'}, {status:${failures ? 400 : 401}});
  if (auth === 'Bearer ' + low) return Response.json({code:'SCOPE_INSUFICIENTE'}, {status:403});
  if (auth !== 'Bearer ' + gestor) throw new Error('credencial inesperada');
  if (${failures} && init.method === 'GET' && path === '/categorias/arbol') return Response.json({code:'SERVICIO_NO_DISPONIBLE'}, {status:503});
  if (${failures} && init.method === 'PATCH' && path.startsWith('/categorias/')) return Response.json({code:'VERSION_CONFLICT'}, {status:409});
  if (${creationFails} && init.method === 'POST' && path === '/categorias') return Response.json({code:'SERVICIO_NO_DISPONIBLE'}, {status:503});
  if (path.startsWith('/taxonomia/operaciones/')) return Response.json({status:'COMPLETED'});
  if (init.method === 'POST' && path.endsWith('/desactivar')) {
    const type = path.split('/')[1]; inactive.add(type);
    return type === 'caracteristicas' ? Response.json({estado:'INACTIVO'}) : Response.json({operation_id:operation}, {status:202});
  }
  if (init.method === 'POST') {
    const key = path === '/categorias' ? 'categoriaId' : path === '/marcas' ? 'marcaId' : 'caracteristicaId';
    return Response.json({[key]:ids[path.slice(1)],version:0,detail:'Bearer ' + gestor}, {status:201});
  }
  if (init.method === 'PATCH') return Response.json({version:1});
  if (path.endsWith('/' + ids[path.split('/')[1]])) return Response.json({estado:inactive.has(path.split('/')[1]) ? 'INACTIVO' : 'ACTIVO'});
  return Response.json({items:[]});
};`;
    const preload = `data:text/javascript;base64,${Buffer.from(fake).toString('base64')}`;
    const result = spawnSync(process.execPath, ['--import', preload, runner], {
      encoding: 'utf8',
      timeout: 15000,
      env: {
        ...process.env,
        JWS_GESTOR_COMERCIAL: gestor,
        JWS_SIN_PERMISOS: includeLow ? low : '',
        QA_CLEANUP_LOGICO: 'aceptado',
      },
    });
    assert.equal(result.status, failures ? 1 : 0, result.stderr);
    const path = /Evidencia: (.+)/.exec(result.stdout)?.[1]?.trim();
    assert.ok(path, result.stdout);
    const raw = readFileSync(path, 'utf8');
    const evidence = JSON.parse(raw);
    assert.equal(
      evidence.result,
      failures ? 'FAIL' : includeLow ? 'PASS' : 'PARTIAL',
    );
    assert.equal(evidence.checks.caracteristicasSinToken, 'PUBLICO_200');
    assert.equal(
      evidence.checks.sinPermisos403,
      includeLow ? 'PASS' : 'PENDIENTE',
    );
    assert.equal(
      evidence.requests.some((item) => item.label === 'sin_rol'),
      includeLow,
    );
    assert.ok(
      evidence.requests.some(
        (item) =>
          item.label === 'sin_credenciales' &&
          item.method === 'POST' &&
          item.path === '/categorias' &&
          item.status === (failures ? 400 : 401),
      ),
    );
    if (failures) assert.ok(evidence.failures.length >= 3);
    for (const label of [
      'crear_categoria',
      ...(creationFails ? [] : ['actualizar_categoria']),
      'crear_marca',
      'actualizar_marca',
      'crear_caracteristica',
      'actualizar_caracteristica',
    ])
      assert.ok(
        evidence.requests.some((item) => item.label === label),
        label,
      );
    assert.equal(evidence.created.length, creationFails ? 2 : 3);
    assert.ok(evidence.created.every((item) => item.cleanup === 'INACTIVO'));
    assert.ok(!raw.includes(gestor) && !raw.includes(low));
  });
}

test('modo check no requiere credenciales ni hace solicitudes', () => {
  const result = spawnSync(process.execPath, [runner, '--check'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no se realizaron solicitudes/);
});
