import { fileURLToPath } from 'node:url';
import { marketplaceRuntime } from './marketplace-runtime.js';

describe('explicit Marketplace integration artifacts', () => {
  const localFile = fileURLToPath(import.meta.url);
  it('requires explicit local paths without defaults from another machine', () => {
    expect(() => marketplaceRuntime('catalog', {})).toThrow(
      'MKT_CATALOG_ENV_FILE',
    );
    expect(() =>
      marketplaceRuntime('taxonomy', { MKT_TAXONOMY_ENV_FILE: '.env.local' }),
    ).toThrow('MKT_TAXONOMY_ENV_FILE');
    expect(() =>
      marketplaceRuntime('catalog', { MKT_CATALOG_ENV_FILE: localFile }),
    ).toThrow('MKT_CATALOG_ENTRYPOINT');
  });
  it('accepts only existing files and keeps the two service selections separate', () => {
    expect(
      marketplaceRuntime('catalog', {
        MKT_CATALOG_ENV_FILE: localFile,
        MKT_CATALOG_ENTRYPOINT: localFile,
      }),
    ).toEqual({ envFile: localFile, entrypoint: localFile });
    expect(() =>
      marketplaceRuntime('taxonomy', {
        MKT_CATALOG_ENV_FILE: localFile,
        MKT_CATALOG_ENTRYPOINT: localFile,
      }),
    ).toThrow('MKT_TAXONOMY_ENV_FILE');
    expect(() =>
      marketplaceRuntime('catalog', {
        MKT_CATALOG_ENV_FILE: localFile + '.missing',
      }),
    ).toThrow('Local file unavailable: MKT_CATALOG_ENV_FILE');
  });
});
