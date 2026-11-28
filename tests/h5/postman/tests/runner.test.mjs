import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeSuite } from '../scripts/run-newman.mjs';
import { sha256Buffer } from '../scripts/lib/sanitizer-core.mjs';

function startOpenApiHarnessServer({
  multiVariantFirst = false,
  paginatedOver20 = false,
  auxPageError = false,
  duplicateIdsAcrossPages = false,
  narrowProductOutOfRange = false,
  invalidDateFormatOnPrice = false,
  producerReturns500 = false,
  requireLocationIdOnInventory = false,
  unsafeRedirectOnHealth = false,
  legacyCamelCaseDto = false,
  emptyCatalog = false,
  wrongPricingSku = false,
  readyReturns503 = false,
  delayMs = 0,
} = {}) {
  const observedRequests = [];

  const simpleProduct = {
    product_id: 'prod-h5-001',
    slug: 'producto-simple-h5',
    name: 'Producto Simple H5',
    description: 'Fixture simple OpenAPI',
    categoria_id: 'cat-h5-001',
    tipo_producto_id: 'tp-h5-001',
    marca_id: 'marca-h5-001',
    tiene_variantes: false,
    sku_base: 'SKU-H5-001',
    images: [],
    attributes: [],
  };

  const multiVariantProduct = {
    product_id: 'prod-h5-002',
    slug: 'producto-multivariante-h5',
    name: 'Producto Multi-Variante H5',
    description: 'Fixture multivariante OpenAPI',
    categoria_id: 'cat-h5-001',
    tipo_producto_id: 'tp-h5-001',
    marca_id: 'marca-h5-001',
    tiene_variantes: true,
    sku_base: null,
    images: [],
    attributes: [],
  };

  // 25 productos en 2 paginas; #23 tiene precio 40 (rango acotado <= 60), resto 80 (rango amplio <= 100)
  const paginatedCatalog = Array.from({ length: 25 }, (_, i) => ({
    product_id: `prod-pag-${String(i + 1).padStart(2, '0')}`,
    slug: `producto-pag-${i + 1}`,
    name: `Producto Paginado ${i + 1}`,
    description: null,
    categoria_id: 'cat-h5-001',
    tipo_producto_id: 'tp-h5-001',
    marca_id: 'marca-h5-001',
    tiene_variantes: false,
    sku_base: `SKU-PAG-${String(i + 1).padStart(2, '0')}`,
    images: [],
    attributes: [],
  }));

  const pricesBySku = {
    'SKU-H5-001': {
      sku: 'SKU-H5-001',
      precio_regular: 55,
      precio_oferta: 45,
      currency: 'PEN',
      channel_id: 'MARKETPLACE',
      valid_from: invalidDateFormatOnPrice ? 'fecha-invalida-h13' : '2026-11-01T00:00:00.000Z',
      valid_until: null,
      price_version: 1,
      vigencia_id: '00000000-0000-4000-8000-000000000101',
      origen: 'PRODUCTO',
    },
    'SKU-H5-VAR-EXPENSIVE': {
      sku: 'SKU-H5-VAR-EXPENSIVE',
      precio_regular: 150,
      precio_oferta: null,
      currency: 'PEN',
      channel_id: 'MARKETPLACE',
      valid_from: '2026-11-01T00:00:00.000Z',
      valid_until: null,
      price_version: 2,
      vigencia_id: '00000000-0000-4000-8000-000000000102',
      origen: 'SKU_OVERRIDE',
    },
    'SKU-H5-VAR-ELIGIBLE': {
      sku: 'SKU-H5-VAR-ELIGIBLE',
      precio_regular: 70,
      precio_oferta: 50,
      currency: 'PEN',
      channel_id: 'MARKETPLACE',
      valid_from: '2026-11-01T00:00:00.000Z',
      valid_until: null,
      price_version: 3,
      vigencia_id: '00000000-0000-4000-8000-000000000103',
      origen: 'SKU_OVERRIDE',
    },
  };

  for (let i = 1; i <= 25; i += 1) {
    const sku = `SKU-PAG-${String(i).padStart(2, '0')}`;
    pricesBySku[sku] = {
      sku,
      precio_regular: i === 23 ? (narrowProductOutOfRange ? 95 : 40) : 80,
      precio_oferta: null,
      currency: 'PEN',
      channel_id: 'MARKETPLACE',
      valid_from: '2026-11-01T00:00:00.000Z',
      valid_until: null,
      price_version: 1,
      vigencia_id: `00000000-0000-4000-8000-0000000002${String(i).padStart(2, '0')}`,
      origen: 'PRODUCTO',
    };
  }

  const server = http.createServer(async (req, res) => {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    const u = new URL(req.url, 'http://127.0.0.1');
    observedRequests.push(`${req.method} ${u.pathname}${u.search}`);
    const corrId = req.headers['x-correlation-id'] || 'harness-corr';
    res.setHeader('X-Correlation-Id', corrId);

    if (u.pathname === '/health') {
      if (unsafeRedirectOnHealth) {
        res.writeHead(302, { Location: 'https://evil.example.com/steal' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'api-gateway' }));
      return;
    }

    if (u.pathname === '/health/ready') {
      if (readyReturns503) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'not_ready', service: 'api-gateway' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ready', service: 'api-gateway' }));
      return;
    }

    if (u.pathname === '/api/v1/ruta-inexistente-h5-probe') {
      res.writeHead(404, { 'Content-Type': 'application/problem+json' });
      res.end(JSON.stringify({ title: 'No encontrado', status: 404, code: 'NO_ENCONTRADO' }));
      return;
    }

    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ') || auth === 'Bearer invalid.jwt.fixture' || auth === 'Bearer ') {
      res.writeHead(401, { 'Content-Type': 'application/problem+json' });
      res.end(JSON.stringify({ title: 'No autenticado', status: 401, code: 'TOKEN_INVALIDO' }));
      return;
    }

    if (u.pathname === '/api/v1/auditoria-precios' && auth === 'Bearer restricted-synth-token') {
      res.writeHead(403, { 'Content-Type': 'application/problem+json' });
      res.end(JSON.stringify({ title: 'Prohibido', status: 403, code: 'SCOPE_INSUFICIENTE' }));
      return;
    }

    if (u.pathname === '/api/v1/productos') {
      if (producerReturns500) {
        res.writeHead(500, { 'Content-Type': 'application/problem+json' });
        res.end(JSON.stringify({ title: 'Error interno', status: 500, code: 'INTERNAL_ERROR' }));
        return;
      }
      const canal = u.searchParams.get('canal');
      const pagina = Number(u.searchParams.get('pagina') || '1');
      const tamanio = Number(u.searchParams.get('tamanio') || '20');
      const min = u.searchParams.get('precioMin');
      const max = u.searchParams.get('precioMax');

      if (canal === 'CANAL_INVALIDO' || pagina < 1) {
        res.writeHead(400, { 'Content-Type': 'application/problem+json' });
        res.end(JSON.stringify({ title: 'Validacion', status: 400, code: 'VALIDACION' }));
        return;
      }
      if (min !== null && max !== null && Number(min) > Number(max)) {
        res.writeHead(400, { 'Content-Type': 'application/problem+json' });
        res.end(JSON.stringify({ title: 'Rango invalido', status: 400, code: 'VALIDACION' }));
        return;
      }
      if (emptyCatalog) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items: [], pagina, tamanio, total: 0 }));
        return;
      }
      if (legacyCamelCaseDto) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items: [{ id: 'prod-h5-001', sku: 'SKU-H5-001', nombre: 'Legacy' }], pagina, tamanio, total: 1 }));
        return;
      }

      if (paginatedOver20) {
        if (pagina > 1 && auxPageError) {
          res.writeHead(500, { 'Content-Type': 'application/problem+json' });
          res.end(JSON.stringify({ title: 'Fallo pagina auxiliar', status: 500, code: 'INTERNAL_ERROR' }));
          return;
        }
        const filtered = paginatedCatalog.filter((p, idx) => {
          const price = idx + 1 === 23 ? 40 : 80;
          if (min !== null && price < Number(min)) return false;
          if (max !== null && price > Number(max)) return false;
          return true;
        });
        const start = (pagina - 1) * tamanio;
        let slice = filtered.slice(start, start + tamanio);
        if (pagina === 2 && duplicateIdsAcrossPages && filtered.length > 0) {
          slice = [filtered[0], ...slice.slice(1)];
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          items: slice,
          pagina,
          tamanio,
          total: filtered.length,
        }));
        return;
      }

      const ordered = multiVariantFirst ? [multiVariantProduct, simpleProduct] : [simpleProduct, multiVariantProduct];
      const effMinPrice = { 'prod-h5-001': 45, 'prod-h5-002': 50 };
      const filtered = ordered.filter((p) => {
        const eff = effMinPrice[p.product_id];
        if (min !== null && eff < Number(min)) return false;
        if (max !== null && eff > Number(max)) return false;
        return true;
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items: filtered, pagina, tamanio, total: filtered.length }));
      return;
    }

    if (u.pathname === '/api/v1/productos/prod-h5-001') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...simpleProduct, marca: { marca_id: 'marca-h5-001', name: 'Marca H5' }, variants: [] }));
      return;
    }

    if (u.pathname === '/api/v1/productos/prod-h5-002') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ...multiVariantProduct,
        marca: { marca_id: 'marca-h5-001', name: 'Marca H5' },
        variants: [
          { variant_id: 'var-h5-01', sku: 'SKU-H5-VAR-EXPENSIVE', identifying_attributes: [], non_identifying_attributes: [], images: [] },
          { variant_id: 'var-h5-02', sku: 'SKU-H5-VAR-ELIGIBLE', identifying_attributes: [], non_identifying_attributes: [], images: [] },
        ],
      }));
      return;
    }

    if (u.pathname.startsWith('/api/v1/productos/prod-pag-')) {
      const pid = u.pathname.split('/').pop();
      const found = paginatedCatalog.find((p) => p.product_id === pid);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...found, marca: { marca_id: 'marca-h5-001', name: 'Marca H5' }, variants: [] }));
      return;
    }

    if (u.pathname.startsWith('/api/v1/productos/') && u.pathname.endsWith('/preparacion')) {
      const pid = u.pathname.split('/')[4];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ product_id: pid, tiene_variantes: false, pricing: { completo: true }, variantes: [] }));
      return;
    }

    if (u.pathname.startsWith('/api/v1/productos/') && u.pathname.endsWith('/variantes')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items: [] }));
      return;
    }

    if (u.pathname.startsWith('/api/v1/productos/00000000-0000-4000-8000-000000000404')) {
      res.writeHead(404, { 'Content-Type': 'application/problem+json' });
      res.end(JSON.stringify({ title: 'No encontrado', status: 404, code: 'PRODUCTO_NO_ENCONTRADO' }));
      return;
    }

    if (u.pathname === '/api/v1/precios') {
      const skus = (u.searchParams.get('skus') || '').split(',').filter(Boolean);
      const items = wrongPricingSku
        ? [{ ...pricesBySku['SKU-H5-001'], sku: 'SKU-INCORRECTO-999' }]
        : skus.map((s) => pricesBySku[s]).filter(Boolean);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items }));
      return;
    }

    if (u.pathname === '/api/v1/inventario/ubicaciones') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        items: [
          { location_id: 'LOC-LIMA-01', name: 'Almacen Lima Norte' },
          { location_id: 'LOC-AREQUIPA-02', name: 'Almacen Arequipa' },
        ],
      }));
      return;
    }

    if (u.pathname === '/api/v1/inventario/disponibilidad') {
      const locationId = u.searchParams.get('location_id');
      if (requireLocationIdOnInventory && !locationId) {
        res.writeHead(400, { 'Content-Type': 'application/problem+json' });
        res.end(JSON.stringify({
          title: 'Solicitud invalida',
          status: 400,
          code: 'VALIDACION',
          detail: 'Debe especificar location_id cuando hay mas de una ubicacion de inventario',
        }));
        return;
      }
      const skus = (u.searchParams.get('skus') || '').split(',').filter(Boolean);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        items: skus.map((s) => ({
          sku: s,
          location_id: locationId || 'LOC-LIMA-01',
          on_hand: 20,
          reserved: 3,
          blocked: 2,
          available: 15,
          status: 'DISPONIBLE',
          threshold: 5,
        })),
      }));
      return;
    }

    if (u.pathname === '/api/v1/inventario/disponibilidad/comercial') {
      const skus = (u.searchParams.get('skus') || '').split(',').filter(Boolean);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items: skus.map((s) => ({ sku: s, status: 'DISPONIBLE' })) }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/problem+json' });
    res.end(JSON.stringify({ title: 'No encontrado', status: 404, code: 'NO_ENCONTRADO' }));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}`, observedRequests });
    });
  });
}

test('H11 + H01 + H03: Smoke PASS devuelve exitCode=0 con reconciliacion exacta entre JSON, JUnit, MD y manifest', async () => {
  const { server, baseUrl } = await startOpenApiHarnessServer();
  const outDir = mkdtempSync(join(tmpdir(), 'g6-h5-pass-'));
  try {
    const res = await executeSuite({
      env: 'local',
      baseUrl,
      profile: 'smoke',
      runId: 'harness-smoke-pass',
      outDir,
      accessToken: 'synth-user-token-harness',
      restrictedAccessToken: 'restricted-synth-token',
      evidenceLevel: 'ISOLATED',
      skipSecretScan: true,
    });
    assert.equal(res.ok, true, `Fallo inesperado: ${JSON.stringify(res)}`);
    assert.equal(res.overallVerdict, 'PASS');
    assert.equal(res.exitCode, 0);
    assert.equal(res.totals.plannedPmCases, 14);
    assert.equal(res.totals.executedPmCases, 14);
    assert.equal(res.totals.notRunPmCases, 0);

    const runDir = join(outDir, 'harness-smoke-pass');
    const manifest = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8'));
    const results = JSON.parse(readFileSync(join(runDir, 'integration-results.json'), 'utf8'));
    const junit = readFileSync(join(runDir, 'newman.junit.xml'), 'utf8');
    const index = JSON.parse(readFileSync(join(runDir, 'evidence-index.json'), 'utf8'));

    assert.equal(manifest.reconciliation.plannedPmCases, results.totals.plannedPmCases);
    assert.equal(manifest.reconciliation.executedPmCases, results.totals.executedPmCases);
    assert.ok(junit.includes(`tests="${results.totals.plannedPmCases}"`));
    for (const art of index.artifacts) {
      assert.equal(sha256Buffer(readFileSync(join(runDir, art.file))), art.sha256);
    }
  } finally {
    server.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('PARTIAL_NOT_COMPLETE devuelve exitCode=5 (nunca 0)', async () => {
  const { server, baseUrl } = await startOpenApiHarnessServer();
  const outDir = mkdtempSync(join(tmpdir(), 'g6-h5-partial-'));
  try {
    const res = await executeSuite({
      env: 'local',
      baseUrl,
      profile: 'smoke',
      runId: 'reg-partial-exit',
      outDir,
      accessToken: 'synth-user-token-harness',
      restrictedAccessToken: '',
      evidenceLevel: 'ISOLATED',
      skipSecretScan: true,
    });
    assert.equal(res.overallVerdict, 'PARTIAL_NOT_COMPLETE');
    assert.equal(res.ok, false);
    assert.equal(res.exitCode, 5);
    assert.equal(res.totals.notRunPmCases, 1);
  } finally {
    server.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('H12 Regresion: Multi-variante con variants[0]=150 y variants[1]=50 pasa correctamente', async () => {
  const { server, baseUrl } = await startOpenApiHarnessServer({ multiVariantFirst: true });
  const outDir = mkdtempSync(join(tmpdir(), 'g6-h5-multivar-'));
  try {
    const res = await executeSuite({
      env: 'local',
      baseUrl,
      folder: '01 - Catalog y Pricing',
      runId: 'reg-multivariant',
      outDir,
      accessToken: 'synth-user-token-harness',
      evidenceLevel: 'ISOLATED',
      skipSecretScan: true,
    });
    assert.equal(res.ok, true, `Fallo en multivariante: ${JSON.stringify(res)}`);
    assert.equal(res.overallVerdict, 'PASS');
  } finally {
    server.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('H11 + H12 Regresion: Paginacion > 20 (25 productos) pasa, separa auxiliares y verifica precios de ambos rangos', async () => {
  const { server, baseUrl } = await startOpenApiHarnessServer({ paginatedOver20: true });
  const outDir = mkdtempSync(join(tmpdir(), 'g6-h5-paginated-'));
  try {
    const res = await executeSuite({
      env: 'local',
      baseUrl,
      folder: '01 - Catalog y Pricing',
      runId: 'reg-paginated-25',
      outDir,
      accessToken: 'synth-user-token-harness',
      evidenceLevel: 'ISOLATED',
      skipSecretScan: true,
    });
    assert.equal(res.ok, true, `Fallo en paginacion > 20: ${JSON.stringify(res)}`);
    assert.equal(res.totals.plannedPmCases, 5);
    assert.equal(res.totals.executedPmCases, 5);
    assert.ok(res.totals.auxiliaryHttpRequests >= 1, 'Debe registrar llamadas auxiliares de paginacion/rango acotado');
  } finally {
    server.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('H12 Regresiones negativas: Fallo HTTP 500 en pagina auxiliar, IDs duplicados y precio fuera de rango acotado producen FAIL', async () => {
  for (const cfg of [
    { name: 'aux-500', opts: { paginatedOver20: true, auxPageError: true } },
    { name: 'dup-ids', opts: { paginatedOver20: true, duplicateIdsAcrossPages: true } },
    { name: 'narrow-price-fail', opts: { paginatedOver20: true, narrowProductOutOfRange: true } },
  ]) {
    const { server, baseUrl } = await startOpenApiHarnessServer(cfg.opts);
    const outDir = mkdtempSync(join(tmpdir(), `g6-h12-${cfg.name}-`));
    try {
      const res = await executeSuite({
        env: 'local',
        baseUrl,
        folder: '01 - Catalog y Pricing',
        runId: `reg-h12-${cfg.name}`,
        outDir,
        accessToken: 'synth-user-token-harness',
        evidenceLevel: 'ISOLATED',
        skipSecretScan: true,
      });
      assert.equal(res.exitCode, 1, `Esperado FAIL en ${cfg.name}`);
      assert.equal(res.overallVerdict, 'FAIL', `Esperado verdict FAIL en ${cfg.name}`);
    } finally {
      server.close();
      rmSync(outDir, { recursive: true, force: true });
    }
  }
});

test('H13 Regresion: Formato date-time invalido en valid_from de Pricing falla validacion de esquema', async () => {
  const { server, baseUrl } = await startOpenApiHarnessServer({ invalidDateFormatOnPrice: true });
  const outDir = mkdtempSync(join(tmpdir(), 'g6-h13-fmt-'));
  try {
    const res = await executeSuite({
      env: 'local',
      baseUrl,
      folder: '01 - Catalog y Pricing',
      runId: 'reg-h13-bad-datetime',
      outDir,
      accessToken: 'synth-user-token-harness',
      evidenceLevel: 'ISOLATED',
      skipSecretScan: true,
    });
    assert.equal(res.exitCode, 1);
    assert.equal(res.overallVerdict, 'FAIL');
  } finally {
    server.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('H14 Regresion: Si productor PM-002/PM-003A falla con 500, consumidores PM-003C/003D abortan con BLOCKED_FIXTURE (NOT_RUN)', async () => {
  const { server, baseUrl } = await startOpenApiHarnessServer({ producerReturns500: true });
  const outDir = mkdtempSync(join(tmpdir(), 'g6-h14-prod-fail-'));
  try {
    const res = await executeSuite({
      env: 'local',
      baseUrl,
      folder: '01 - Catalog y Pricing',
      runId: 'reg-h14-producer-500',
      outDir,
      accessToken: 'synth-user-token-harness',
      evidenceLevel: 'ISOLATED',
      skipSecretScan: true,
    });
    assert.equal(res.exitCode, 1);
    assert.equal(res.overallVerdict, 'FAIL');
    const results = JSON.parse(readFileSync(join(outDir, 'reg-h14-producer-500', 'integration-results.json'), 'utf8'));
    const pm003c = results.cases.find((c) => c.pmId === 'PM-003C');
    const pm003d = results.cases.find((c) => c.pmId === 'PM-003D');
    assert.equal(pm003c.status, 'NOT_RUN');
    assert.ok(pm003c.blockerReason.includes('BLOCKED_FIXTURE'));
    assert.equal(pm003d.status, 'NOT_RUN');
    assert.ok(pm003d.blockerReason.includes('BLOCKED_FIXTURE'));
  } finally {
    server.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('H14 Regresion sintetica PM-080/081/082: PASS completo con tokens M2M y NOT_RUN sin fixture sku', async () => {
  const { server, baseUrl } = await startOpenApiHarnessServer();
  const outDir = mkdtempSync(join(tmpdir(), 'g6-h14-m2m-'));
  try {
    const passRes = await executeSuite({
      env: 'local',
      baseUrl,
      folder: '10 - Integraciones externas',
      runId: 'reg-m2m-pass',
      outDir,
      marketplaceAccessToken: 'synth-marketplace-token',
      ventasAccessToken: 'synth-ventas-token',
      evidenceLevel: 'ISOLATED',
      skipSecretScan: true,
    });
    assert.equal(passRes.ok, true, `Fallo M2M sintetico: ${JSON.stringify(passRes)}`);
    assert.equal(passRes.overallVerdict, 'PASS');
    assert.equal(passRes.totals.pass, 3);

    const blockedRes = await executeSuite({
      env: 'local',
      baseUrl,
      folder: '10 - Integraciones externas',
      runId: 'reg-m2m-blocked-fixture',
      outDir,
      ventasAccessToken: 'synth-ventas-token',
      sku: '',
      evidenceLevel: 'ISOLATED',
      skipSecretScan: true,
    });
    assert.equal(blockedRes.overallVerdict, 'PARTIAL_NOT_COMPLETE');
    assert.equal(blockedRes.exitCode, 5);
    const results = JSON.parse(readFileSync(join(outDir, 'reg-m2m-blocked-fixture', 'integration-results.json'), 'utf8'));
    const pm082 = results.cases.find((c) => c.pmId === 'PM-082');
    assert.equal(pm082.status, 'NOT_RUN');
    assert.ok(pm082.blockerReason.includes('BLOCKED_FIXTURE'));
  } finally {
    server.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('Defecto B Regresion: Inventory multi-ubicacion exige location_id; PM-012 lo descubre via /ubicaciones y pasa 200 OK', async () => {
  const { server, baseUrl, observedRequests } = await startOpenApiHarnessServer({
    requireLocationIdOnInventory: true,
  });
  const outDir = mkdtempSync(join(tmpdir(), 'g6-defect-b-'));
  try {
    const res = await executeSuite({
      env: 'local',
      baseUrl,
      folder: '02 - Preparacion comercial e Inventory',
      runId: 'reg-defect-b-location-id',
      outDir,
      accessToken: 'synth-user-token-harness',
      productId: 'prod-h5-001',
      sku: 'SKU-H5-001',
      evidenceLevel: 'ISOLATED',
      skipSecretScan: true,
    });
    assert.equal(res.ok, true, `PM-012 debio descubrir location_id y pasar 200 OK: ${JSON.stringify(res)}`);
    assert.equal(res.overallVerdict, 'PASS');
    assert.ok(
      observedRequests.some((r) => r.includes('/api/v1/inventario/disponibilidad') && r.includes('location_id=LOC-LIMA-01')),
      'PM-012 debe enviar location_id descubierto',
    );
  } finally {
    server.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('H15 Regresion: Redireccion 302 hacia host externo no se sigue y falla asercion de seguridad', async () => {
  const { server, baseUrl } = await startOpenApiHarnessServer({ unsafeRedirectOnHealth: true });
  const outDir = mkdtempSync(join(tmpdir(), 'g6-h15-redir-'));
  try {
    const res = await executeSuite({
      env: 'local',
      baseUrl,
      folder: '00 - Preflight y autenticacion',
      runId: 'reg-unsafe-redirect',
      outDir,
      allowNoAuth: true,
      evidenceLevel: 'ISOLATED',
      skipSecretScan: true,
    });
    assert.equal(res.exitCode, 1);
    assert.equal(res.overallVerdict, 'FAIL');
  } finally {
    server.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('H06 Regresiones: DTO legacy camelCase, catalogo vacio, SKU erroneo en Pricing, readiness 503 y timeout producen FAIL', async () => {
  for (const cfg of [
    { name: 'legacy-dto', opts: { legacyCamelCaseDto: true }, folder: '01 - Catalog y Pricing' },
    { name: 'empty-cat', opts: { emptyCatalog: true }, folder: '01 - Catalog y Pricing' },
    { name: 'wrong-sku', opts: { wrongPricingSku: true }, folder: '01 - Catalog y Pricing' },
    { name: 'ready-503', opts: { readyReturns503: true }, folder: '00 - Preflight y autenticacion', allowNoAuth: true },
    { name: 'timeout', opts: { delayMs: 500 }, folder: '00 - Preflight y autenticacion', allowNoAuth: true, timeoutRequestMs: 120 },
  ]) {
    const { server, baseUrl } = await startOpenApiHarnessServer(cfg.opts);
    const outDir = mkdtempSync(join(tmpdir(), `g6-h06-${cfg.name}-`));
    try {
      const res = await executeSuite({
        env: 'local',
        baseUrl,
        folder: cfg.folder,
        runId: `reg-${cfg.name}`,
        outDir,
        accessToken: 'synth-user-token-harness',
        allowNoAuth: Boolean(cfg.allowNoAuth),
        timeoutRequestMs: cfg.timeoutRequestMs,
        evidenceLevel: 'ISOLATED',
        skipSecretScan: true,
      });
      assert.equal(res.exitCode, 1, `Esperado FAIL en ${cfg.name}`);
      assert.equal(res.overallVerdict, 'FAIL', `Esperado verdict FAIL en ${cfg.name}`);
      assert.equal(existsSync(join(outDir, `reg-${cfg.name}`, 'report.md')), true);
    } finally {
      server.close();
      rmSync(outDir, { recursive: true, force: true });
    }
  }
});
