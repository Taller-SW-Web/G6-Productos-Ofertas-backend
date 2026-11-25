import test from 'node:test';
import assert from 'node:assert/strict';
import { createDomainSeederHarness } from './domain-seeder-harness.mjs';

const safeContext = { explicitApply: true, createdByHarness: true, resourceRegistryId: 'POMA_H5_DISPOSABLE', databaseHost: '127.0.0.1', databaseName: 'h5_disposable_catalog', supabaseTarget: null };

test('dry-run no invokes domain seeders ni writes', async () => {
  const harness = createDomainSeederHarness();
  let calls = 0;
  harness.register('catalog', { create: async () => { calls += 1; }, cleanup: async () => {} });
  assert.deepEqual(await harness.prepare({ mode: 'dry-run', domains: ['catalog'] }), { mode: 'dry-run', registeredDomains: ['catalog'], resourcesCreated: 0, writes: 0 });
  assert.equal(calls, 0);
});

test('apply blocks missing owner seeders and non-disposable or shared targets', async () => {
  const harness = createDomainSeederHarness();
  await assert.rejects(harness.prepare({ mode: 'apply', domains: ['pricing'], context: safeContext }), /DOMAIN_SEEDER_MISSING/);
  await assert.rejects(harness.prepare({ mode: 'apply', domains: ['catalog'], context: { ...safeContext, databaseHost: 'db.shared.invalid' } }), /NON_DISPOSABLE_DATABASE_REJECTED/);
  await assert.rejects(harness.prepare({ mode: 'apply', domains: ['catalog'], context: { ...safeContext, supabaseTarget: 'shared' } }), /SHARED_OR_OPERATIONAL_TARGET_REJECTED/);
  await assert.rejects(harness.prepare({ mode: 'apply', domains: ['catalog'], context: { ...safeContext, explicitApply: false } }), /APPLY_EXPLICIT_OPT_IN_REQUIRED/);
});

test('apply registers only harness-created disposable resources and cleanup is idempotent', async () => {
  const harness = createDomainSeederHarness();
  const cleaned = [];
  harness.register('catalog', {
    create: async ({ registerResource }) => {
      const resource = { id: 'catalog-db-1', createdByHarness: true, disposable: true };
      registerResource(resource);
      return resource;
    },
    cleanup: async resource => { cleaned.push(resource.id); },
  });
  await assert.rejects(harness.prepare({ mode: 'apply', domains: ['catalog'], context: { ...safeContext, databaseName: 'catalog' } }), /NON_DISPOSABLE_DATABASE_REJECTED/);
  assert.deepEqual(await harness.prepare({ mode: 'apply', domains: ['catalog'], context: safeContext }), { mode: 'apply', registeredDomains: ['catalog'], resourcesCreated: 1, writes: null, writesReportedByOwnerSeeder: false });
  assert.deepEqual(await harness.cleanup(), { cleaned: 1 });
  assert.deepEqual(await harness.cleanup(), { cleaned: 0 });
  assert.deepEqual(cleaned, ['catalog-db-1']);
  assert.deepEqual(harness.registeredResources(), []);
});

test('cleans already registered resources if a later owner seeder fails', async () => {
  const harness = createDomainSeederHarness();
  let cleanupCount = 0;
  harness.register('catalog', {
    create: async ({ registerResource }) => {
      const resource = { id: 'catalog-db-2', createdByHarness: true, disposable: true };
      registerResource(resource);
      return resource;
    },
    cleanup: async () => { cleanupCount += 1; },
  });
  harness.register('pricing', { create: async () => { throw new Error('synthetic seeder failure'); }, cleanup: async () => {} });
  await assert.rejects(harness.prepare({ mode: 'apply', domains: ['catalog', 'pricing'], context: safeContext }), /synthetic seeder failure/);
  assert.equal(cleanupCount, 1);
  assert.deepEqual(harness.registeredResources(), []);
});
