import { describe, expect, it } from 'vitest';
import {
  AllowTaxonomyServiceClients,
  RequireTaxonomyCommercialUser,
  readTaxonomyPublicReadConfig,
} from './taxonomy-auth.js';
import { CategorySeoController } from './category-seo.controller.js';

describe('Taxonomy SEO G7 authorization (R2)', () => {
  it('rejects PUBLIC_READ_ONLY and non-empty TAXONOMY_PUBLIC_OPERATION_IDS', () => {
    expect(() =>
      readTaxonomyPublicReadConfig({
        NODE_ENV: 'production',
        G6_SECURITY_MODE: 'PUBLIC_READ_ONLY',
      }),
    ).toThrow();
    expect(() =>
      readTaxonomyPublicReadConfig({
        NODE_ENV: 'production',
        TAXONOMY_PUBLIC_OPERATION_IDS: 'obtenerSeoPorSlug',
      }),
    ).toThrow();
  });

  it('decorates SEO read handlers with commercial user and service client metadata', () => {
    expect(typeof AllowTaxonomyServiceClients).toBe('function');
    expect(typeof RequireTaxonomyCommercialUser).toBe('function');
    expect(CategorySeoController.prototype.obtenerPublico).toBeDefined();
    expect(CategorySeoController.prototype.resolverAnterior).toBeDefined();
  });
});
