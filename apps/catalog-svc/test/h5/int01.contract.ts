import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildManifest } from '../fixtures/h5/catalog-h5-fixture.mjs';
import { pollPreparation } from './poll-preparation.mjs';

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
      { httpStatus: 202, preparationStatus: 'COMPLETED' },
      { httpStatus: 200, preparationStatus: 'PENDING' },
      { httpStatus: 200, preparationStatus: 'COMPLETED' },
    ];
    let attempts = 0;
    const result = await pollPreparation(async () => sequence[attempts++], {
      deadlineMs: 5000,
      intervalMs: 0,
      maxAttempts: 3,
      wait: async () => undefined,
    });
    expect(result).toEqual({
      state: 'COMPLETED',
      attempts: 3,
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
    await expect(
      pollPreparation(
        async () => ({ httpStatus: 200, preparationStatus: 'REJECTED' }),
        options,
      ),
    ).resolves.toMatchObject({ state: 'REJECTED' });
    await expect(
      pollPreparation(
        async () => ({ httpStatus: 200, preparationStatus: 'INDETERMINATE' }),
        options,
      ),
    ).resolves.toMatchObject({
      state: 'INCONCLUSIVE',
      reason: 'DEPENDENCY_INDETERMINATE',
    });
    await expect(
      pollPreparation(
        async () => ({ httpStatus: 202, preparationStatus: 'ACCEPTED' }),
        options,
      ),
    ).resolves.toMatchObject({
      state: 'INCONCLUSIVE',
      reason: 'POLL_DEADLINE_EXCEEDED',
    });
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
});
