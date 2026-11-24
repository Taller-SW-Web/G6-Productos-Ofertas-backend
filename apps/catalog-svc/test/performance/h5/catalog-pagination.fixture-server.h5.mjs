import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest, COMMERCIAL_CHANNELS } from '../../fixtures/h5/catalog-h5-fixture.mjs';

const localBearer = 'poma-h5-local-fixture-only';

function summary(product) {
  return {
    product_id: product.product_id,
    slug: product.product_id,
    name: product.nombre,
    description: null,
    categoria_id: 'CAT-H5',
    tipo_producto_id: 'TYPE-H5',
    marca_id: 'BRAND-H5',
    tiene_variantes: product.variants.length > 0,
    sku_base: product.variants.length > 0 ? null : product.sku_base,
    images: [],
    attributes: [],
  };
}

function send(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

export async function startCatalogPaginationFixtureServer({ manifest = buildManifest() } = {}) {
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${localBearer}`) return send(response, 401, { status: 401, code: 'TOKEN_INVALIDO' });
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/health') return send(response, 200, { status: 'READY' });
    if (request.method !== 'GET') return send(response, 405, { status: 405, code: 'METODO_NO_PERMITIDO' });

    if (url.pathname === '/api/v1/productos') {
      const channel = url.searchParams.get('canal');
      const page = Number(url.searchParams.get('pagina'));
      const pageSize = Number(url.searchParams.get('tamanio'));
      if (!COMMERCIAL_CHANNELS.includes(channel) || !Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 || !['NOMBRE_ASC', null].includes(url.searchParams.get('orden'))) {
        return send(response, 400, { status: 400, code: 'VALIDACION' });
      }
      const eligible = manifest.products.filter(product => product.eligible_channels.includes(channel))
        .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es') || a.product_id.localeCompare(b.product_id, 'en'));
      const offset = (page - 1) * pageSize;
      return send(response, 200, { items: eligible.slice(offset, offset + pageSize).map(summary), pagina: page, tamanio: pageSize, total: eligible.length });
    }

    const match = /^\/api\/v1\/productos\/([^/]+)$/.exec(url.pathname);
    if (match) {
      const channel = url.searchParams.get('canal');
      if (!COMMERCIAL_CHANNELS.includes(channel)) return send(response, 400, { status: 400, code: 'VALIDACION' });
      const product = manifest.products.find(item => item.product_id === match[1] && item.eligible_channels.includes(channel));
      if (!product) return send(response, 404, { status: 404, code: 'PRODUCTO_NO_ENCONTRADO' });
      const variants = product.variants.filter(variant => variant.eligible && variant.state === 'ACTIVA')
        .map(variant => ({ variant_id: variant.variant_id, sku: variant.sku, identifying_attributes: [], non_identifying_attributes: [], images: [] }));
      return send(response, 200, { ...summary(product), marca: { marca_id: 'BRAND-H5', name: 'Marca H5 sintética', status: 'ACTIVA' }, variants });
    }
    return send(response, 404, { status: 404, code: 'NO_ENCONTRADO' });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string' || server.address()?.address !== '127.0.0.1') {
    await new Promise(resolve => server.close(resolve));
    throw new Error('H5_FIXTURE_SERVER_NOT_LOOPBACK');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    authorization: `Bearer ${localBearer}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await startCatalogPaginationFixtureServer();
  process.stdout.write(`${JSON.stringify({ status: 'READY', base_url: server.baseUrl })}\n`);
  const shutdown = async () => { await server.close(); process.exit(0); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
