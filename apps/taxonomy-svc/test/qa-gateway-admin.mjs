import { randomUUID } from 'node:crypto';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Solo QA; no permite sustituir el origen ni recibir tokens como argumentos.
const BASE =
  'https://api-gateway.calmgrass-aec0b33c.chilecentral.azurecontainerapps.io/api/v1';
const checkOnly = process.argv.slice(2).includes('--check');
if (process.argv.slice(2).some((arg) => arg !== '--check'))
  throw new Error('Argumento no permitido');
const logo = await readFile(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures/logo.png'),
);
if (checkOnly) {
  if (logo.length < 32 || logo.subarray(0, 4).toString('hex') !== '89504e47')
    throw new Error('Fixture PNG inválida');
  console.log(
    'Preparación local PASS: origen QA fijado, PNG presente; no se realizaron solicitudes.',
  );
  process.exit(0);
}

function token(name) {
  const value = process.env[name];
  if (!value || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value))
    throw new Error(`${name} debe contener un JWS de tres segmentos`);
  let header;
  try {
    header = JSON.parse(
      Buffer.from(value.split('.')[0], 'base64url').toString('utf8'),
    );
  } catch {
    throw new Error(`${name}: cabecera JWS inválida`);
  }
  if (header.alg !== 'RS256') throw new Error(`${name} debe usar RS256`);
  return value;
}
const gestor = token('JWS_GESTOR_COMERCIAL');
const sinPermisos = process.env.JWS_SIN_PERMISOS
  ? token('JWS_SIN_PERMISOS')
  : undefined;
if (sinPermisos && gestor === sinPermisos)
  throw new Error('Se requieren dos identidades distintas');
if (process.env.QA_CLEANUP_LOGICO !== 'aceptado')
  throw new Error(
    'Indique QA_CLEANUP_LOGICO=aceptado: la baja no elimina físicamente los registros',
  );
const evidenceDir = await mkdtemp(join(tmpdir(), 'taxonomy-qa-'));
const evidencePath = join(evidenceDir, 'evidence.json');
const report = {
  target: BASE,
  startedAt: new Date().toISOString(),
  expectedDeploymentSha: 'b061ef86ec63a06ba626c3f7a66c94cd7fc270db',
  shaSource: 'reportado por el usuario; no verificado por este script',
  cleanup: 'baja lógica, no borrado físico',
  requests: [],
  created: [],
  failures: [],
  checks: { sinPermisos403: sinPermisos ? 'PENDIENTE_EJECUCION' : 'PENDIENTE' },
  result: 'RUNNING',
};
const created = [];
const correlation = () => randomUUID();
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const scrub = (value) => {
  if (typeof value === 'string')
    return value
      .replace(/Bearer\s+\S+/gi, '[REDACTADO]')
      .replace(
        /\b[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g,
        '[REDACTADO]',
      )
      .slice(0, 4000);
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /token|authorization|password|secret|cookie/i.test(key)
          ? '[REDACTADO]'
          : scrub(item),
      ]),
    );
  return value;
};
async function request(
  label,
  method,
  path,
  credential,
  body,
  expected,
  list = false,
) {
  const id = correlation();
  const headers = { Accept: 'application/json', 'X-Correlation-Id': id };
  if (credential) headers.Authorization = `Bearer ${credential}`;
  if (body && !(body instanceof FormData))
    headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch(BASE + path, {
      method,
      headers,
      body:
        body instanceof FormData
          ? body
          : body
            ? JSON.stringify(body)
            : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(45000),
    });
  } catch {
    report.requests.push({
      label,
      method,
      path,
      correlationId: id,
      error: 'ERROR_RED_O_TIMEOUT',
    });
    throw new Error(
      `${label}: error de red o timeout; una escritura podría requerir reconciliación manual`,
    );
  }
  let text;
  try {
    text = await response.text();
  } catch {
    report.requests.push({
      label,
      method,
      path,
      correlationId: id,
      status: response.status,
      error: 'ERROR_LECTURA_RESPUESTA',
    });
    throw new Error(
      `${label}: no se pudo leer la respuesta; si fue una escritura, revisar reconciliación manual`,
    );
  }
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { nonJson: true };
  }
  // Los listados pueden contener datos ajenos al ensayo: registrar solo cantidades.
  const captured = list
    ? {
        count: Array.isArray(data)
          ? data.length
          : Array.isArray(data?.items)
            ? data.items.length
            : null,
      }
    : scrub(data);
  report.requests.push({
    label,
    method,
    path,
    correlationId: id,
    status: response.status,
    contentType: response.headers.get('content-type'),
    response: captured,
  });
  if (!expected.includes(response.status))
    throw new Error(
      `${label}: HTTP ${response.status}, esperado ${expected.join('/')}`,
    );
  return data;
}
function objectId(data, key, label) {
  const id = data?.[key];
  if (typeof id !== 'string' || !uuid.test(id))
    throw new Error(
      `${label}: identificador ausente o inválido; revisar manualmente la creación`,
    );
  return id;
}
function form(fields, includeLogo = false) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields))
    data.set(key, String(value));
  if (includeLogo)
    data.set('logo', new Blob([logo], { type: 'image/png' }), 'qa-logo.png');
  return data;
}
async function terminal(type, id) {
  const response = await request(
    `baja_${type}`,
    'POST',
    `/${type === 'categoria' ? 'categorias' : 'marcas'}/${id}/desactivar`,
    gestor,
    undefined,
    [202],
  );
  const operation = objectId(response, 'operation_id', `baja_${type}`);
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const state = await request(
      `estado_${type}`,
      'GET',
      `/taxonomia/operaciones/${operation}`,
      gestor,
      undefined,
      [200],
    );
    if (state.status === 'COMPLETED') {
      const entity = await request(
        `verificar_inactiva_${type}`,
        'GET',
        `/${type === 'categoria' ? 'categorias' : 'marcas'}/${id}`,
        gestor,
        undefined,
        [200],
      );
      if (entity?.estado !== 'INACTIVO')
        throw new Error(`baja_${type}: entidad inactiva no confirmada`);
      return;
    }
    if (state.status === 'REJECTED')
      throw new Error(
        `baja_${type}: operación rechazada; requiere reconciliación`,
      );
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(
    `baja_${type}: sin confirmación terminal; requiere reconciliación`,
  );
}
async function attempt(label, action) {
  try {
    return await action();
  } catch (error) {
    report.failures.push(
      `${label}: ${error instanceof Error ? error.message : 'ERROR_DESCONOCIDO'}`,
    );
    return undefined;
  }
}
try {
  const suffix = randomUUID().slice(0, 8);
  await attempt('401', () =>
    request('sin_credenciales', 'POST', '/categorias', undefined, {}, [401]),
  );
  const publicResult = await attempt('lectura_publica', async () => {
    await request(
      'observacion_publica',
      'GET',
      '/caracteristicas',
      undefined,
      undefined,
      [200, 401, 403],
      true,
    );
    return report.requests.at(-1).status;
  });
  report.checks.caracteristicasSinToken =
    publicResult === 200 ? 'PUBLICO_200' : (publicResult ?? 'ERROR');
  if (sinPermisos) {
    const result = await attempt('403', async () => {
      await request(
        'sin_rol',
        'GET',
        '/caracteristicas',
        sinPermisos,
        undefined,
        [403],
      );
      return true;
    });
    report.checks.sinPermisos403 = result ? 'PASS' : 'FAIL';
  }
  for (const path of [
    '/categorias/arbol',
    '/categorias/administracion?pagina=1&tamanio=20',
    '/marcas/administracion?pagina=1&tamanio=20',
    '/caracteristicas?pagina=1&tamanio=20',
  ])
    await attempt(`lectura ${path}`, () =>
      request(
        'lectura_administrativa',
        'GET',
        path,
        gestor,
        undefined,
        [200],
        true,
      ),
    );

  const category = await attempt('crear_categoria', async () => {
    const value = await request(
      'crear_categoria',
      'POST',
      '/categorias',
      gestor,
      {
        nombre: `QA categoria ${suffix}`,
        slugConfirmado: `qa-categoria-${suffix}`,
      },
      [201],
    );
    const id = objectId(value, 'categoriaId', 'crear_categoria');
    created.push({ type: 'categoria', id });
    report.created.push({ type: 'categoria', id });
    return { id, version: value.version };
  });
  if (category) {
    await attempt('leer_categoria', () =>
      request(
        'leer_categoria',
        'GET',
        `/categorias/${category.id}`,
        gestor,
        undefined,
        [200],
      ),
    );
    await attempt('actualizar_categoria', () =>
      request(
        'actualizar_categoria',
        'PATCH',
        `/categorias/${category.id}`,
        gestor,
        { nombre: `QA categoria editada ${suffix}`, version: category.version },
        [200],
      ),
    );
  }

  const brand = await attempt('crear_marca', async () => {
    const value = await request(
      'crear_marca',
      'POST',
      '/marcas',
      gestor,
      form({ nombre: `QA marca ${suffix}` }, true),
      [201],
    );
    const id = objectId(value, 'marcaId', 'crear_marca');
    created.push({ type: 'marca', id });
    report.created.push({ type: 'marca', id });
    return { id, version: value.version };
  });
  if (brand) {
    await attempt('leer_marca', () =>
      request(
        'leer_marca',
        'GET',
        `/marcas/${brand.id}`,
        gestor,
        undefined,
        [200],
      ),
    );
    await attempt('actualizar_marca', () =>
      request(
        'actualizar_marca',
        'PATCH',
        `/marcas/${brand.id}`,
        gestor,
        form({ nombre: `QA marca editada ${suffix}`, version: brand.version }),
        [200],
      ),
    );
  }

  const characteristic = await attempt('crear_caracteristica', async () => {
    const value = await request(
      'crear_caracteristica',
      'POST',
      '/caracteristicas',
      gestor,
      { nombre: `QA caracteristica ${suffix}`, tipo: 'TEXTO' },
      [201],
    );
    const id = objectId(value, 'caracteristicaId', 'crear_caracteristica');
    created.push({ type: 'caracteristica', id });
    report.created.push({ type: 'caracteristica', id });
    return { id, version: value.version };
  });
  if (characteristic) {
    await attempt('leer_caracteristica', () =>
      request(
        'leer_caracteristica',
        'GET',
        `/caracteristicas/${characteristic.id}`,
        gestor,
        undefined,
        [200],
      ),
    );
    await attempt('actualizar_caracteristica', () =>
      request(
        'actualizar_caracteristica',
        'PATCH',
        `/caracteristicas/${characteristic.id}`,
        gestor,
        {
          nombre: `QA caracteristica editada ${suffix}`,
          version: characteristic.version,
        },
        [200],
      ),
    );
  }
} finally {
  for (const item of created.reverse()) {
    try {
      if (item.type === 'caracteristica') {
        const result = await request(
          'baja_caracteristica',
          'POST',
          `/caracteristicas/${item.id}/desactivar`,
          gestor,
          undefined,
          [200],
        );
        if (result?.estado !== 'INACTIVO')
          throw new Error('baja_caracteristica: estado terminal no confirmado');
        const stored = await request(
          'verificar_inactiva_caracteristica',
          'GET',
          `/caracteristicas/${item.id}`,
          gestor,
          undefined,
          [200],
        );
        if (stored?.estado !== 'INACTIVO')
          throw new Error(
            'baja_caracteristica: lectura posterior no confirmó INACTIVO',
          );
      } else await terminal(item.type, item.id);
      const tracked = report.created.find((entry) => entry.id === item.id);
      if (tracked) tracked.cleanup = 'INACTIVO';
    } catch (error) {
      report.failures.push(
        error instanceof Error ? error.message : `limpieza_${item.type}: error`,
      );
    }
  }
  report.finishedAt = new Date().toISOString();
  report.result = report.failures.length
    ? 'FAIL'
    : sinPermisos
      ? 'PASS'
      : 'PARTIAL';
  await writeFile(evidencePath, JSON.stringify(report, null, 2), {
    mode: 0o600,
    flag: 'wx',
  });
  console.log(`Resultado: ${report.result}. Evidencia: ${evidencePath}`);
  if (report.failures.length) process.exitCode = 1;
}
