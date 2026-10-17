export const CATALOG_TAXONOMY_CONFIG = Symbol('CATALOG_TAXONOMY_CONFIG');

export function readTaxonomyConfig(
  env: Record<string, string | undefined> = process.env,
) {
  let origin: string | undefined;
  if (env.CATALOG_TAXONOMY_URL !== undefined) {
    try {
      const url = new URL(env.CATALOG_TAXONOMY_URL);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
      )
        throw new Error();
      origin = url.origin;
    } catch {
      throw new Error(
        'CATALOG_TAXONOMY_URL debe ser un origen HTTP(S) sin credenciales.',
      );
    }
  }
  return Object.freeze({ origin });
}

export type TaxonomyConfig = ReturnType<typeof readTaxonomyConfig>;
