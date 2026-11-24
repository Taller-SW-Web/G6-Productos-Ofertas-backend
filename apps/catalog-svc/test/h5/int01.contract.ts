import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildManifest } from '../fixtures/h5/catalog-h5-fixture.mjs';
import { pollPreparation } from './poll-preparation.mjs';
import { classifyPreparationResponse, CONTRACT_OPERATIONS, CONTRACT_VERSION, DOCS_SHA, verifyRealProviderTrace } from './int01-contract-oracles.mjs';

type Scenario = {
  id: string;
  input: Record<string, unknown>;
  required_providers: string[];
  providers_started: string[];
  providers_queried: string[];
  providers_participating: string[];
  simulated_providers: string[];
  oracles: Record<string, string>;
  expected_result: Record<string, unknown>;
  observed_result: unknown;
  identity_authorization: {
    identity: string;
    scope_source: string;
    verification: string;
  };
  evidence_level: string;
  state: string;
};

const scenarios = JSON.parse(
  await readFile(
    resolve('apps/catalog-svc/test/h5/int01-scenarios.json'),
    'utf8',
  ),
) as Scenario[];

const preparation = (status: 'PENDING' | 'COMPLETED' | 'REJECTED') => ({
  product_id: '3c81175c-7c2c-5ec8-8a99-c76e29955338',
  tiene_variantes: false,
  pricing: { status, manual_retry_allowed: status === 'REJECTED' },
  inventario: { status, manual_retry_allowed: status === 'REJECTED' },
  variantes: [],
});

describe('INT-01 L0 contractual scenario registry', () => {
  it('registra escenarios sin atribuirles ejecución de proveedores', () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(12);
    expect(new Set(scenarios.map(({ id }) => id)).size).toBe(scenarios.length);
    for (const scenario of scenarios) {
      expect(scenario.id).toMatch(/^INT01-[A-Z0-9-]+$/);
      expect(scenario.required_providers.length).toBeGreaterThan(0);
      expect(scenario.providers_started).toEqual([]);
      expect(scenario.providers_queried).toEqual([]);
      expect(scenario.providers_participating).toEqual([]);
      expect(scenario.simulated_providers).toEqual([]);
      expect(scenario.oracles).not.toEqual({});
      expect(scenario.expected_result).not.toEqual({});
      expect(scenario.observed_result).toBeNull();
      expect(scenario.identity_authorization.verification).toBe('NOT_RUN');
      expect(scenario.evidence_level).toBe('L0_STATIC');
      expect(scenario.state).toBe('NOT_RUN');
    }
  });

  it('exige un recorrido positivo común que incluya los tres proveedores reales', () => {
    const positive = scenarios.filter(({ id }) =>
      ['INT01-SIMPLE-COMPLETO', 'INT01-VARIANTES-CANAL-GLOBAL'].includes(id),
    );
    expect(positive).toHaveLength(2);
    for (const scenario of positive) {
      expect(scenario.required_providers).toEqual([
        'catalog-svc',
        'pricing-svc',
        'inventory-svc',
      ]);
      expect(scenario.simulated_providers).toEqual([]);
      expect(scenario.oracles).toMatchObject({
        product_sku: 'catalog-svc',
        effective_price: 'pricing-svc',
        stock: 'inventory-svc',
      });
    }
  });

  it('alinea las identidades de producto, sku_base y SKU vendibles al manifest', () => {
    const manifest = buildManifest();
    const expectedProducts = scenarios.filter(
      ({ id }) => id === 'INT01-SIMPLE-COMPLETO',
    );
    expect(expectedProducts).toHaveLength(1);
    expect(expectedProducts[0].input.fixture_sku_base).toBe(
      'POMA-H5-SIMPLE-0001',
    );
    expect(manifest.expected.product_ids).toHaveLength(
      manifest.products.length,
    );
    expect(manifest.expected.sku_bases).toHaveLength(manifest.products.length);
    expect(manifest.expected.sellable_skus.map(({ sku }) => sku)).toContain(
      'POMA-H5-SIMPLE-0001',
    );
    expect(manifest.expected.sellable_skus.map(({ sku }) => sku)).not.toContain(
      'POMA-H5-VAR-DISABLED-0004',
    );
  });

  it('acredita polling acotado y nunca trata HTTP 202 como estado terminal', async () => {
    const sequence = [
      { httpStatus: 200, body: preparation('PENDING') },
      { httpStatus: 200, body: preparation('COMPLETED') },
    ];
    let attempts = 0;
    const result = await pollPreparation(async () => sequence[attempts++], {
      deadlineMs: 5000,
      intervalMs: 0,
      maxAttempts: 2,
      wait: async () => undefined,
    });
    expect(result).toEqual({
      state: 'COMPLETED',
      attempts: 2,
      httpStatus: 200,
    });
  });

  it('registra rechazo terminal, indeterminación de proveedor y timeout como resultados distintos', async () => {
    const options = {
      deadlineMs: 1000,
      intervalMs: 0,
      maxAttempts: 2,
      wait: async () => undefined,
    };
    await expect(pollPreparation(async () => ({ httpStatus: 200, body: preparation('REJECTED') }), options))
      .resolves.toMatchObject({ state: 'REJECTED' });
    await expect(pollPreparation(async () => ({ httpStatus: 200, body: preparation('PENDING') }), { ...options, maxAttempts: 1 }))
      .resolves.toMatchObject({ state: 'INCONCLUSIVE', reason: 'POLL_DEADLINE_EXCEEDED' });
    await expect(
      pollPreparation(async () => ({ httpStatus: 202, body: { status: 'ACCEPTED' } }), options),
    ).rejects.toThrow('POLL_HTTP_STATUS_UNEXPECTED');
    await expect(
      pollPreparation(async () => ({ httpStatus: 503, preparationStatus: 'COMPLETED' }), options),
    ).rejects.toThrow('POLL_HTTP_STATUS_UNEXPECTED');
    await expect(
      pollPreparation(async () => ({ httpStatus: 401, preparationStatus: 'COMPLETED' }), options),
    ).rejects.toThrow('POLL_HTTP_STATUS_UNEXPECTED');
  });

  it('rechaza evidencia que contenga secretos o datos personales mediante canarios', async () => {
    const { assertSafeEvidenceText } = await import('./evidence-security.mjs');
    const safe = JSON.stringify({
      scenario_id: 'INT01-SIMPLE-COMPLETO',
      state: 'NOT_RUN',
    });
    expect(() => assertSafeEvidenceText(safe)).not.toThrow();
    for (const canary of [
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYW5hcnkifQ.signature',
      'Authorization: Bearer fake-token-value',
      'Cookie: session=fake-cookie-value',
      'postgresql://user:fake-password@db.private.example:5432/catalog',
      'password=fake-password-value',
      'base64: Y2FuYXJ5LXRlc3QtY3JlZGVudGlhbA==',
      'qa.person@example.test',
      'https://pricing.internal.example/private-m2m',
    ]) {
      expect(() => assertSafeEvidenceText(canary)).toThrow('EVIDENCE_REJECTED');
    }
  });

  it('fija las operaciones usadas por INT-01 al OpenAPI rc.3 revisado', () => {
    expect(DOCS_SHA).toBe('40524e96c6973f84d74160076781702fe2a3da19');
    expect(CONTRACT_VERSION).toBe('0.7.0-rc.3');
    expect(CONTRACT_OPERATIONS.map(({ id, method, path, success }) => [id, method, path, success])).toEqual([
      ['catalog-admin-list', 'GET', '/productos/administracion', 200],
      ['catalog-commercial-list', 'GET', '/productos?canal={channel}&pagina={page}&tamanio={pageSize}', 200],
      ['catalog-commercial-detail', 'GET', '/productos/{productoId}?canal={channel}', 200],
      ['catalog-product-create', 'POST', '/productos', 201],
      ['catalog-product-edit', 'PATCH', '/productos/{productoId}', 200],
      ['catalog-product-activate', 'POST', '/productos/{productoId}/activar', 200],
      ['catalog-preparation-read', 'GET', '/productos/{productoId}/preparacion', 200],
      ['catalog-preparation-retry', 'POST', '/productos/{productoId}/preparacion/reintentar', 202],
      ['pricing-effective-read', 'GET', '/precios/skus/{sku}?canal={channel}', 200],
      ['pricing-update', 'PATCH', '/precios/skus/{sku}', 200],
      ['inventory-availability-read', 'GET', '/inventario/disponibilidad?skus={sku}', 200],
    ]);
  });

  it('clasifica 202 solo como admisión con receipt y terminales solo desde la consulta normativa', () => {
    const accepted = { status: 'ACCEPTED', operation_id: '00000000-0000-4000-8000-000000000001', correlation_id: '00000000-0000-4000-8000-000000000002' };
    expect(classifyPreparationResponse(202, accepted, 'catalog-preparation-retry')).toEqual({ state: 'PENDING', terminal: false });
    expect(classifyPreparationResponse(200, preparation('PENDING'), 'catalog-preparation-read')).toEqual({ state: 'PENDING', terminal: false });
    expect(classifyPreparationResponse(200, preparation('COMPLETED'), 'catalog-preparation-read')).toEqual({ state: 'COMPLETED', terminal: true });
    expect(classifyPreparationResponse(200, preparation('REJECTED'), 'catalog-preparation-read')).toEqual({ state: 'REJECTED', terminal: true });
    expect(() => classifyPreparationResponse(202, { ...accepted, status: 'COMPLETED' }, 'catalog-preparation-retry')).toThrow('INT01_ACCEPTED_RESPONSE_INVALID');
    expect(() => classifyPreparationResponse(202, { ...accepted, operation_id: '' }, 'catalog-preparation-retry')).toThrow('INT01_ACCEPTED_RESPONSE_INVALID');
    expect(() => classifyPreparationResponse(200, preparation('COMPLETED'), 'catalog-preparation-retry')).toThrow('INT01_PREPARATION_HTTP_STATUS_INVALID');
    for (const status of [401, 403, 404, 409, 503]) {
      expect(() => classifyPreparationResponse(status, preparation('COMPLETED'), 'catalog-preparation-read')).toThrow('INT01_PREPARATION_HTTP_STATUS_INVALID');
    }
    expect(() => classifyPreparationResponse(200, { ...preparation('PENDING'), pricing: { status: 'INDETERMINATE', manual_retry_allowed: false } }, 'catalog-preparation-read')).toThrow('INT01_PREPARATION_DEPENDENCY_INVALID');
  });

  it('requiere participación real, correlacionada y autorizada de los tres proveedores para INT-01 L1', () => {
    const trace = ['catalog-svc', 'pricing-svc', 'inventory-svc'].map(provider => ({
      provider, started: true, queried: true, participated: true, simulated: false, identityAuthorized: true,
      sourceSha: 'a'.repeat(40), operationId: 'op-1', correlationId: 'corr-1',
    }));
    expect(verifyRealProviderTrace(trace, ['catalog-svc', 'pricing-svc', 'inventory-svc'], 'a'.repeat(40))).toMatchObject({ providers: ['catalog-svc', 'pricing-svc', 'inventory-svc'] });
    expect(() => verifyRealProviderTrace(trace.filter(item => item.provider !== 'inventory-svc'), ['catalog-svc', 'pricing-svc', 'inventory-svc'], 'a'.repeat(40))).toThrow('INT01_PROVIDER_NOT_EFFECTIVELY_PARTICIPATING');
    expect(() => verifyRealProviderTrace(trace.map(item => item.provider === 'pricing-svc' ? { ...item, simulated: true } : item), ['catalog-svc', 'pricing-svc', 'inventory-svc'], 'a'.repeat(40))).toThrow('INT01_PROVIDER_SIMULATED');
    expect(() => verifyRealProviderTrace(trace.map(item => item.provider === 'inventory-svc' ? { ...item, identityAuthorized: false } : item), ['catalog-svc', 'pricing-svc', 'inventory-svc'], 'a'.repeat(40))).toThrow('INT01_PROVIDER_AUTHORIZATION_UNVERIFIED');
  });

  it('rechaza trazas de proveedor con SHA u operación/correlación divergentes', () => {
    const trace = ['catalog-svc', 'pricing-svc', 'inventory-svc'].map(provider => ({
      provider, started: true, queried: true, participated: true, simulated: false, identityAuthorized: true,
      sourceSha: 'a'.repeat(40), operationId: 'op-1', correlationId: 'corr-1',
    }));
    expect(() => verifyRealProviderTrace(trace.map(item => item.provider === 'pricing-svc' ? { ...item, operationId: 'op-2' } : item), ['catalog-svc', 'pricing-svc', 'inventory-svc'], 'a'.repeat(40))).toThrow('INT01_PROVIDER_TRACE_NOT_CORRELATED');
    expect(() => verifyRealProviderTrace(trace.map(item => item.provider === 'inventory-svc' ? { ...item, sourceSha: 'bad-sha' } : item), ['catalog-svc', 'pricing-svc', 'inventory-svc'], 'a'.repeat(40))).toThrow('INT01_PROVIDER_PROVENANCE_INVALID');
    expect(() => verifyRealProviderTrace(trace, ['catalog-svc', 'pricing-svc', 'inventory-svc'], 'b'.repeat(40))).toThrow('INT01_PROVIDER_SOURCE_SHA_MISMATCH');
  });
});
