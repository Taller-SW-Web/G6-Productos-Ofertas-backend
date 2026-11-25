const KNOWN_DOMAINS = new Set(['catalog', 'pricing', 'inventory']);

function isLoopback(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

export function createDomainSeederHarness() {
  const seeders = new Map();
  const resources = new Map();
  let cleaning = null;

  function register(domain, seeder) {
    if (!KNOWN_DOMAINS.has(domain)) throw new Error('DOMAIN_NOT_ALLOWED');
    if (seeders.has(domain)) throw new Error('DOMAIN_SEEDER_DUPLICATE');
    if (!seeder || typeof seeder.create !== 'function' || typeof seeder.cleanup !== 'function')
      throw new Error('DOMAIN_SEEDER_INTERFACE_INVALID');
    seeders.set(domain, seeder);
  }

  function validateApplyContext(context) {
    if (context?.mode !== 'apply' || context?.explicitApply !== true) throw new Error('APPLY_EXPLICIT_OPT_IN_REQUIRED');
    if (context?.createdByHarness !== true || context?.resourceRegistryId !== 'POMA_H5_DISPOSABLE')
      throw new Error('DISPOSABLE_RESOURCE_REGISTRY_REQUIRED');
    if (!isLoopback(context.databaseHost) || !/^h5_disposable_[a-z0-9_]+$/.test(context.databaseName ?? ''))
      throw new Error('NON_DISPOSABLE_DATABASE_REJECTED');
    if (context.supabaseTarget || context.operationalData === true || context.sharedResource === true)
      throw new Error('SHARED_OR_OPERATIONAL_TARGET_REJECTED');
  }

  async function prepare({ mode = 'dry-run', domains = ['catalog', 'pricing', 'inventory'], context = {} } = {}) {
    for (const domain of domains) if (!KNOWN_DOMAINS.has(domain)) throw new Error('DOMAIN_NOT_ALLOWED');
    if (mode === 'dry-run') return { mode, registeredDomains: domains.filter(domain => seeders.has(domain)), resourcesCreated: 0, writes: 0 };
    if (mode !== 'apply') throw new Error('FIXTURE_MODE_INVALID');
    validateApplyContext({ ...context, mode, explicitApply: context.explicitApply });
    const missing = domains.filter(domain => !seeders.has(domain));
    if (missing.length) throw new Error(`DOMAIN_SEEDER_MISSING:${missing.join(',')}`);

    const created = [];
    try {
      for (const domain of domains) {
        const seeder = seeders.get(domain);
        const resource = await seeder.create({
          registerResource(value) {
            if (!value || value.createdByHarness !== true || value.disposable !== true || typeof value.id !== 'string' || !value.id)
              throw new Error('RESOURCE_NOT_HARNESS_CREATED');
            const key = `${domain}:${value.id}`;
            if (resources.has(key)) throw new Error('RESOURCE_ALREADY_REGISTERED');
            resources.set(key, { domain, seeder, value });
            created.push(key);
          },
          context,
        });
        if (resource && !created.some(key => resources.get(key)?.value === resource))
          throw new Error('SEEDER_RETURNED_UNREGISTERED_RESOURCE');
      }
      return { mode, registeredDomains: domains, resourcesCreated: created.length, writes: null, writesReportedByOwnerSeeder: false };
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  async function cleanup() {
    if (cleaning) return cleaning;
    cleaning = (async () => {
      const entries = [...resources.entries()].reverse();
      const failures = [];
      for (const [key, entry] of entries) {
        try {
          await entry.seeder.cleanup(entry.value);
          resources.delete(key);
        } catch {
          failures.push(key);
        }
      }
      if (failures.length) throw new Error('DISPOSABLE_RESOURCE_CLEANUP_FAILED');
      return { cleaned: entries.length };
    })();
    try { return await cleaning; } finally { cleaning = null; }
  }

  return Object.freeze({ register, prepare, cleanup, registeredDomains: () => [...seeders.keys()], registeredResources: () => [...resources.keys()] });
}
