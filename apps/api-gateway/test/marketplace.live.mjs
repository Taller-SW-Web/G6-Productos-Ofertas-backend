import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

// Prueba HTTP externa: no crea proveedores, tokens, datos ni conexiones SQL.
// Los negativos deben ser tokens firmados del issuer de prueba, con una sola
// condición inválida. Nunca usar credenciales productivas en un issuer local.
const names = [
  'MKT_GATEWAY_ORIGIN',
  'MKT_FIXTURE_FILE',
  'MKT_SERVICE_TOKEN',
  'MKT_EXPIRED_TOKEN',
  'MKT_WRONG_AUDIENCE_TOKEN',
  'MKT_WRONG_SCOPE_TOKEN',
  'MKT_WRONG_CLIENT_TOKEN',
  'MKT_GATEWAY_SHA',
  'MKT_TAXONOMY_SHA',
  'MKT_CATALOG_SHA',
];
const missing = names.filter((name) => !process.env[name]);
if (missing.length) {
  console.log(JSON.stringify({ result: 'NO_EJECUTADO', missing }));
  process.exit(2);
}

let currentCase = 'configuracion';
const results = [];
try {
  const origin = new URL(process.env.MKT_GATEWAY_ORIGIN);
  assert(['http:', 'https:'].includes(origin.protocol));
  assert(
    !origin.username && !origin.password && !origin.search && !origin.hash,
  );
  assert.equal(origin.pathname, '/');
  if (origin.protocol === 'http:')
    assert(['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname));
  for (const name of ['MKT_GATEWAY_SHA', 'MKT_TAXONOMY_SHA', 'MKT_CATALOG_SHA'])
    assert.match(process.env[name], /^[0-9a-f]{40}$/);
  const raw = await readFile(process.env.MKT_FIXTURE_FILE);
  const fixture = JSON.parse(raw);
  for (const name of [
    'activeCategoryId',
    'inactiveCategoryId',
    'eligibleProductId',
    'ineligibleProductId',
    'eligibleSlug',
    'ineligibleSlug',
    'missingSlug',
    'search',
    'emptySearch',
    'sourceEvidence',
  ])
    assert.equal(typeof fixture[name], 'string');
  for (const value of Object.values(fixture))
    if (typeof value === 'string') assert(value.trim().length > 0);
  assert.notEqual(fixture.eligibleProductId, fixture.ineligibleProductId);
  assert.notEqual(fixture.activeCategoryId, fixture.inactiveCategoryId);
  const paths = [
    '/api/v1/categorias',
    `/api/v1/productos?${new URLSearchParams({ canal: 'MARKETPLACE', q: fixture.search, pagina: '1', tamanio: '100' })}`,
    `/api/v1/productos/por-slug/${encodeURIComponent(fixture.eligibleSlug)}?canal=MARKETPLACE`,
  ];
  async function call(label, path, token, status, code) {
    currentCase = label;
    const correlation = randomUUID();
    const response = await fetch(new URL(path, origin), {
      headers: {
        accept: 'application/json',
        'X-Correlation-Id': correlation,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.status, status);
    assert.equal(response.headers.get('x-correlation-id'), correlation);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(
      response.headers.get('content-type')?.split(';')[0],
      code ? 'application/problem+json' : 'application/json',
    );
    const body = await response.json();
    if (code) {
      assert.equal(body.status, status);
      assert.equal(body.code, code);
      assert.equal(body.correlationId, correlation);
    }
    results.push({
      case: label,
      status: response.status,
      correlationId: correlation,
    });
    return body;
  }
  const allowed = new Set([
    'product_id',
    'slug',
    'name',
    'description',
    'categoria_id',
    'tipo_producto_id',
    'marca_id',
    'tiene_variantes',
    'sku_base',
    'images',
    'attributes',
    'marca',
    'variants',
  ]);
  function product(value) {
    for (const name of [
      'product_id',
      'slug',
      'name',
      'categoria_id',
      'tipo_producto_id',
      'marca_id',
    ])
      assert.equal(typeof value[name], 'string');
    assert.equal(typeof value.tiene_variantes, 'boolean');
    for (const name of Object.keys(value)) assert(allowed.has(name));
  }
  const categories = await call(
    'categorias-activas',
    paths[0],
    process.env.MKT_SERVICE_TOKEN,
    200,
  );
  assert(Array.isArray(categories.categories));
  assert(
    categories.categories.some(
      (c) => c.categoria_id === fixture.activeCategoryId,
    ),
  );
  for (const category of categories.categories) {
    assert.equal(category.status, 'ACTIVA');
    assert.equal(typeof category.name, 'string');
    assert.notEqual(category.categoria_id, fixture.inactiveCategoryId);
  }
  const page = await call(
    'busqueda-elegible',
    paths[1],
    process.env.MKT_SERVICE_TOKEN,
    200,
  );
  assert.equal(page.pagina, 1);
  assert.equal(page.tamanio, 100);
  assert(Number.isInteger(page.total) && page.total >= page.items.length);
  assert(page.items.some((p) => p.product_id === fixture.eligibleProductId));
  for (const item of page.items) {
    product(item);
    assert.notEqual(item.product_id, fixture.ineligibleProductId);
  }
  const empty = await call(
    'busqueda-vacia',
    `/api/v1/productos?${new URLSearchParams({ canal: 'MARKETPLACE', q: fixture.emptySearch, pagina: '1', tamanio: '24' })}`,
    process.env.MKT_SERVICE_TOKEN,
    200,
  );
  assert.deepEqual(empty, { items: [], pagina: 1, tamanio: 24, total: 0 });
  const detail = await call(
    'detalle-elegible',
    paths[2],
    process.env.MKT_SERVICE_TOKEN,
    200,
  );
  product(detail);
  assert.equal(detail.product_id, fixture.eligibleProductId);
  assert.equal(detail.slug, fixture.eligibleSlug);
  assert(detail.marca && typeof detail.marca === 'object');
  assert(Array.isArray(detail.variants));
  if (!detail.tiene_variantes) assert.equal(typeof detail.sku_base, 'string');
  for (const variant of detail.variants) {
    assert.equal(typeof variant.variant_id, 'string');
    assert.equal(typeof variant.sku, 'string');
    assert.notEqual(variant.variant_id, variant.sku);
    for (const name of Object.keys(variant))
      assert(
        [
          'variant_id',
          'sku',
          'identifying_attributes',
          'non_identifying_attributes',
          'images',
        ].includes(name),
      );
  }
  for (const field of ['ineligibleSlug', 'missingSlug'])
    await call(
      field,
      `/api/v1/productos/por-slug/${encodeURIComponent(fixture[field])}?canal=MARKETPLACE`,
      process.env.MKT_SERVICE_TOKEN,
      404,
      'PRODUCTO_NO_ENCONTRADO',
    );
  for (const [index, path] of paths.entries()) {
    for (const [label, token, status, code] of [
      ['sin-token', undefined, 401, 'TOKEN_INVALIDO'],
      ['expirado', process.env.MKT_EXPIRED_TOKEN, 401, 'TOKEN_INVALIDO'],
      [
        'audiencia',
        process.env.MKT_WRONG_AUDIENCE_TOKEN,
        401,
        'TOKEN_INVALIDO',
      ],
      ['scope', process.env.MKT_WRONG_SCOPE_TOKEN, 403, 'SCOPE_INSUFICIENTE'],
      [
        'cliente',
        process.env.MKT_WRONG_CLIENT_TOKEN,
        403,
        'SCOPE_INSUFICIENTE',
      ],
    ])
      await call(`${index}-${label}`, path, token, status, code);
  }
  console.log(
    JSON.stringify({
      result: 'PASS_HTTP_SMOKE',
      results,
      fixtureSha256: createHash('sha256').update(raw).digest('hex'),
      shas: Object.fromEntries(
        names.filter((n) => n.endsWith('_SHA')).map((n) => [n, process.env[n]]),
      ),
      limits:
        'No acredita SQL, schema completo, BFF, navegador, homologacion ni despliegue.',
    }),
  );
} catch {
  // No volcar errores de fetch, bodies, tokens, URLs ni configuración privada.
  console.log(
    JSON.stringify({ result: 'FAIL', case: currentCase, completed: results }),
  );
  process.exitCode = 1;
}
