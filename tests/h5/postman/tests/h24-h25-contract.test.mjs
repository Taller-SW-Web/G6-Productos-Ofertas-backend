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

test('H25: executeSuite en modo estricto falla cerrado (stage=contract_preflight, exitCode=2) si falta OpenAPI oficial', async () => {
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
  assert.ok(res.errors.some((e) => e.includes('H25')));
});
