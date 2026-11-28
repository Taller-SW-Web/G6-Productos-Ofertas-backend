import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OFFICIAL_OPENAPI_CONTRACT_PATH,
  SCHEMAS_PATH,
} from '../scripts/lib/constants.mjs';
import {
  validateNewmanExecutionsWithAjv,
  verifySchemaContractAlignment,
} from '../scripts/lib/openapi-schema-validator.mjs';
import { executeSuite } from '../scripts/run-newman.mjs';

function makeExec({ itemName = '', method = 'GET', url, code = 200, contentType = 'application/json', body }) {
  return {
    item: { name: itemName },
    request: { method, url },
    response: {
      code,
      header: [{ key: 'Content-Type', value: contentType }],
      stream: body !== undefined ? Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    },
  };
}

test('H24: rechaza respuestas invalidas de Combos, Promotions e Inventory resueltas por metodo/ruta OpenAPI', () => {
  const rawSummary = {
    run: {
      executions: [
        // 1) Combos invalido (falta pagina/tamanio/total y tipo erroneo de items)
        makeExec({
          itemName: 'PM-020 - Combos: Listar combos administrativos',
          url: 'http://127.0.0.1:3000/api/v1/combos?pagina=1&tamanio=10',
          body: { items: 'no-es-array' },
        }),
        // 2) Promotions invalido
        makeExec({
          itemName: 'PM-060 - Promotions: Listar promociones vigentes por canal',
          url: 'http://127.0.0.1:3000/api/v1/promociones?canal=MARKETPLACE&vigentes=true',
          body: { items: [{ id: 12345 }] },
        }),
        // 3) Inventory invalido (available negativo y status fuera de enum)
        makeExec({
          itemName: 'PM-012 - Inventory: Disponibilidad autoritativa por SKU encadenado',
          url: 'http://127.0.0.1:3000/api/v1/inventario/disponibilidad?skus=SKU-1',
          body: { items: [{ sku: 'SKU-1', on_hand: 10, reserved: 0, blocked: 0, available: -5, status: 'INVENTADO' }] },
        }),
      ],
    },
  };

  const res = validateNewmanExecutionsWithAjv(rawSummary, OFFICIAL_OPENAPI_CONTRACT_PATH);
  assert.equal(res.ok, false);
  assert.equal(res.violations.length, 3, `Deben fallar Combos, Promotions e Inventory: ${JSON.stringify(res.violations)}`);
});

test('H24: respuesta auxiliar de Catalog asociada a caso PM-003D (Pricing) se valida con esquema de Catalog, no de Pricing', () => {
  const validCatalogDetail = {
    product_id: 'prod-1',
    slug: 'prod-1',
    name: 'Producto 1',
    categoria_id: 'cat-1',
    tipo_producto_id: 'tp-1',
    marca_id: 'm-1',
    tiene_variantes: false,
    sku_base: 'SKU-1',
    marca: { marca_id: 'm-1', name: 'Marca 1' },
    variants: [],
  };

  // Valida cuando el detalle de Catalog cumple ProductoDetalleComercial aunque herede item.name de PM-003D
  const okRes = validateNewmanExecutionsWithAjv(
    {
      run: {
        executions: [
          makeExec({
            itemName: 'PM-003D - Pricing: Consultar precios efectivos',
            url: 'http://127.0.0.1:3000/api/v1/productos/prod-1?canal=MARKETPLACE',
            body: validCatalogDetail,
          }),
        ],
      },
    },
    OFFICIAL_OPENAPI_CONTRACT_PATH,
  );
  assert.equal(okRes.ok, true, `Detalle Catalog valido bajo PM-003D debio aprobar: ${JSON.stringify(okRes.violations)}`);

  // Falla cuando el detalle auxiliar de Catalog incumple ProductoDetalleComercial
  const badRes = validateNewmanExecutionsWithAjv(
    {
      run: {
        executions: [
          makeExec({
            itemName: 'PM-003D - Pricing: Consultar precios efectivos',
            url: 'http://127.0.0.1:3000/api/v1/productos/prod-1?canal=MARKETPLACE',
            body: { product_id: 'prod-1' },
          }),
        ],
      },
    },
    OFFICIAL_OPENAPI_CONTRACT_PATH,
  );
  assert.equal(badRes.ok, false);
  assert.equal(badRes.violations.length, 1);
});

test('H24: respuesta auxiliar invalida sin identificador PM y Content-Type incorrecto son rechazados', () => {
  const res = validateNewmanExecutionsWithAjv(
    {
      run: {
        executions: [
          // Auxiliar sin PM ID con body invalido
          makeExec({
            itemName: 'https://apim-g6-productos-chile.azure-api.net/api/v1/productos?pagina=2',
            url: 'https://apim-g6-productos-chile.azure-api.net/api/v1/productos?pagina=2',
            body: { items: 'invalido' },
          }),
          // Content-Type incorrecto (text/plain en lugar de application/json)
          makeExec({
            itemName: 'PM-002 - Gateway -> Catalog: Listar productos autorizados',
            url: 'https://apim-g6-productos-chile.azure-api.net/api/v1/productos?canal=MARKETPLACE&pagina=1&tamanio=10',
            contentType: 'text/plain',
            body: 'plain text',
          }),
        ],
      },
    },
    OFFICIAL_OPENAPI_CONTRACT_PATH,
  );
  assert.equal(res.ok, false);
  assert.equal(res.violations.length, 2);
  assert.equal(res.violations[0].pmId, 'AUX');
  assert.ok(res.violations[1].errors[0].includes('Content-Type'));
});

test('H24: cambio contractual en esquema anidado (VarianteComercial dentro de ProductoDetalleComercial.variants[]) es detectado', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'g6-h24-nested-'));
  try {
    const drifted = JSON.parse(readFileSync(SCHEMAS_PATH, 'utf8'));
    drifted.$defs.VarianteComercial.properties.sku.type = 'integer';
    const driftPath = join(tmp, 'nested-drift.json');
    writeFileSync(driftPath, JSON.stringify(drifted), 'utf8');
    const check = verifySchemaContractAlignment(OFFICIAL_OPENAPI_CONTRACT_PATH, driftPath);
    assert.equal(check.ok, false);
    assert.ok(check.errors.some((e) => e.includes('variants[].sku') || e.includes('VarianteComercial.sku')));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('H25 + H32: executeSuite en modo estricto falla cerrado (stage=contract_preflight, exitCode=2) si falta o se sustituye OpenAPI oficial', async () => {
  const res = await executeSuite({
    env: 'local',
    baseUrl: 'http://127.0.0.1:39999',
    folder: '00 - Preflight y autenticacion',
    allowNoAuth: true,
    skipSecretScan: true,
    openApiPath: 'C:/ruta/inexistente/openapi.yaml',
  });
  assert.equal(res.ok, false);
  assert.equal(res.exitCode, 2);
  assert.equal(res.stage, 'contract_preflight');
  assert.ok(res.errors.some((e) => e.includes('H25') || e.includes('H32')));
});

test('H32: modo STRICT_OFFICIAL rechaza archivo OpenAPI o CSV sustituido y compilacion Ajv previa detiene antes de enviar solicitudes HTTP', async () => {
  let serverHits = 0;
  const server = http.createServer((_req, res) => {
    serverHits += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const tmp = mkdtempSync(join(tmpdir(), 'g6-h32-prov-'));
  try {
    // 1) Copia valida del OpenAPI oficial fuera del checkout -> STRICT_OFFICIAL debe rechazarla (H32)
    const copiedOpenApi = join(tmp, 'copied-openapi.yaml');
    writeFileSync(copiedOpenApi, readFileSync(OFFICIAL_OPENAPI_CONTRACT_PATH, 'utf8'), 'utf8');
    const subRes = await executeSuite({
      env: 'local',
      baseUrl,
      folder: '00 - Preflight y autenticacion',
      allowNoAuth: true,
      skipSecretScan: true,
      openApiPath: copiedOpenApi,
    });
    assert.equal(subRes.ok, false);
    assert.equal(subRes.exitCode, 2);
    assert.equal(subRes.stage, 'contract_preflight');
    assert.ok(subRes.errors.some((e) => e.includes('H32')));
    assert.equal(serverHits, 0, 'No debe enviar solicitudes HTTP si falla procedencia H32');

    // 2) Esquema no compilable en OpenAPI (fastDev para probar compilacion previa) -> falla en contract_preflight con 0 HTTP hits
    const brokenOpenApi = join(tmp, 'broken-openapi.yaml');
    const rawYaml = readFileSync(OFFICIAL_OPENAPI_CONTRACT_PATH, 'utf8');
    const brokenYaml = rawYaml.replace(
      'PaginaProductosComercial:',
      'PaginaProductosComercial:\n      $ref: "#/components/schemas/ESQUEMA_INEXISTENTE_H32"\n    PaginaProductosComercialOriginal:',
    );
    writeFileSync(brokenOpenApi, brokenYaml, 'utf8');
    const compileFailRes = await executeSuite({
      env: 'local',
      baseUrl,
      folder: '00 - Preflight y autenticacion',
      allowNoAuth: true,
      skipSecretScan: true,
      fastDev: true,
      openApiPath: brokenOpenApi,
    });
    assert.equal(compileFailRes.ok, false);
    assert.equal(compileFailRes.exitCode, 2);
    assert.equal(compileFailRes.stage, 'contract_preflight');
    assert.equal(serverHits, 0, 'No debe enviar solicitudes HTTP si falla compilacion Ajv previa H32');
  } finally {
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('H31: violacion contractual auxiliar sin PM provoca FAIL global (exitCode=1) sin inflar casos PM fallidos y reconcilia JSON, JUnit, MD y manifest', async () => {
  const mkProd = (idx) => ({
    product_id: `00000000-0000-4000-8000-${String(idx).padStart(12, '0')}`,
    slug: `prod-h31-${idx}`,
    name: `Producto H31 ${idx}`,
    description: `Fixture H31 ${idx}`,
    categoria_id: 'cat-h31',
    tipo_producto_id: 'type-h31',
    marca_id: 'brand-h31',
    tiene_variantes: false,
    sku_base: `SKU-H31-${idx}`,
    images: [],
    attributes: [],
  });
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/api/v1/precios') {
      // Solicitud auxiliar sin identificador PM: viola contrato OpenAPI de Pricing
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items: [{ sku: 12345, precio_efectivo: 'no-numero' }] }));
      return;
    }
    if (u.pathname === '/api/v1/productos') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items: [mkProd(1)], pagina: 1, tamanio: 20, total: 1 }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/problem+json' });
    res.end(JSON.stringify({ title: 'No encontrado', status: 404, code: 'NO_ENCONTRADO' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const outDir = mkdtempSync(join(tmpdir(), 'g6-h31-aux-'));
  const miniCollectionPath = join(outDir, 'h31-mini.postman_collection.json');
  writeFileSync(
    miniCollectionPath,
    JSON.stringify({
      info: {
        name: 'H31 Mini Collection',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      item: [
        {
          name: '01 - Catalog y Pricing',
          item: [
            {
              name: 'PM-002 - Gateway -> Catalog: Listar productos autorizados',
              protocolProfileBehavior: { followRedirects: false },
              request: {
                method: 'GET',
                header: [{ key: 'Authorization', value: 'Bearer {{accessToken}}' }],
                url: {
                  raw: '{{baseUrl}}/api/v1/productos?canal=MARKETPLACE&pagina=1&tamanio=20',
                  host: ['{{baseUrl}}'],
                  path: ['api', 'v1', 'productos'],
                  query: [
                    { key: 'canal', value: 'MARKETPLACE' },
                    { key: 'pagina', value: '1' },
                    { key: 'tamanio', value: '20' },
                  ],
                },
              },
              event: [
                {
                  listen: 'test',
                  script: {
                    type: 'text/javascript',
                    exec: [
                      'pm.test("PM-002 HTTP 200", function () { pm.response.to.have.status(200); });',
                      'pm.sendRequest({ url: pm.environment.get("baseUrl") + "/api/v1/precios?skus=SKU-H31-1&canal=MARKETPLACE", method: "GET", header: { Authorization: "Bearer " + pm.environment.get("accessToken") } }, function (_err, _res) {});',
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    }),
    'utf8',
  );
  try {
    const res = await executeSuite({
      env: 'local',
      baseUrl,
      folder: '01 - Catalog y Pricing',
      runId: 'h31-aux-violation',
      outDir,
      collectionPath: miniCollectionPath,
      fastDev: true,
      openApiPath: OFFICIAL_OPENAPI_CONTRACT_PATH,
      accessToken: 'synth-user-token-h31',
      evidenceLevel: 'ISOLATED',
      skipSecretScan: true,
    });
    assert.equal(res.ok, false);
    assert.equal(res.exitCode, 1, `Esperado exitCode=1, recibido ${res.exitCode}: ${JSON.stringify(res.errors || res)}`);
    assert.equal(res.overallVerdict, 'FAIL');
    if (res.totals.pmPass !== 1) {
      console.error('H31 REPORT:', readFileSync(join(res.evidenceDir, 'report.md'), 'utf8'));
    }
    assert.equal(res.totals.pmPass, 1, 'PM-002 debe permanecer PASS');
    assert.equal(res.totals.pmFail, 0, 'pmFail NO debe inflarse por violacion auxiliar sin PM');
    assert.equal(res.totals.fail, 0, 'fail de casos PM NO debe mezclarse con violacion auxiliar');
    assert.equal(res.totals.auxiliaryContractViolations, 1, 'Debe registrar 1 violacion contractual auxiliar separada');
    assert.equal(
      res.totals.plannedPmCases,
      res.totals.executedPmCases + res.totals.notRunPmCases,
      'Denominadores PM deben reconciliar exactamente',
    );
    assert.equal(res.totals.pmPass + res.totals.pmFail, res.totals.executedPmCases);

    const manifest = JSON.parse(readFileSync(join(res.evidenceDir, 'manifest.json'), 'utf8'));
    const results = JSON.parse(readFileSync(join(res.evidenceDir, 'integration-results.json'), 'utf8'));
    const junit = readFileSync(join(res.evidenceDir, 'newman.junit.xml'), 'utf8');
    const md = readFileSync(join(res.evidenceDir, 'report.md'), 'utf8');

    assert.equal(manifest.reconciliation.auxiliaryContractViolations, 1);
    assert.equal(manifest.reconciliation.pmPass, 1);
    assert.equal(manifest.reconciliation.pmFail, 0);
    assert.equal(manifest.contract.mode, 'FAST_DEV_NON_AUTHORITATIVE');
    assert.match(manifest.contract.openApiSha256, /^[0-9a-f]{64}$/);
    assert.equal(results.totals.auxiliaryContractViolations, 1);
    assert.ok(junit.includes('H31.AuxiliaryContract'), 'JUnit debe registrar la violacion contractual auxiliar');
    assert.ok(junit.includes('failures="1"'), 'JUnit debe contabilizar el fallo auxiliar');
    assert.ok(md.includes('Violaciones contractuales auxiliares'), 'Markdown debe reportar violaciones auxiliares');
  } finally {
    server.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});
