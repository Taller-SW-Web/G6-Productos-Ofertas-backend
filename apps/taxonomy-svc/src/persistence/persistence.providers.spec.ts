import { describe, expect, it, afterEach } from 'vitest';
import {
  crearRepositorioDrizzle,
  proveedorDeRepositorio,
} from './persistence.providers.js';
import { TaxonomySvcModule } from '../taxonomy-svc.module.js';
import { TAXONOMY_REPOSITORY } from '../taxonomy.repository.js';
import { DrizzleTaxonomyRepository } from './drizzle-taxonomy.repository.js';

describe('proveedorDeRepositorio y crearRepositorioDrizzle — salvaguarda en producción (#P1)', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalNodeEnv !== undefined) {
      process.env.NODE_ENV = originalNodeEnv;
    } else {
      delete process.env.NODE_ENV;
    }
  });

  it('impide invocar crearRepositorioDrizzle en runtime productivo sin garantías TLS/identidad', () => {
    process.env.NODE_ENV = 'production';
    expect(() =>
      crearRepositorioDrizzle(
        'postgresql://usuario:clave@localhost:5432/taxonomy',
      ),
    ).toThrow(
      'crearRepositorioDrizzle no está permitido en runtime productivo; use iniciarTaxonomySvc con Database y las garantías obligatorias de TLS e identidad.',
    );
  });

  it('impide proveedorDeRepositorio con databaseUrl en runtime productivo', () => {
    process.env.NODE_ENV = 'production';
    expect(() =>
      proveedorDeRepositorio(
        'postgresql://usuario:clave@localhost:5432/taxonomy',
      ),
    ).toThrow(
      'El repositorio Drizzle basado en databaseUrl no está permitido en runtime productivo; use iniciarTaxonomySvc con Database y las garantías obligatorias de TLS e identidad.',
    );
  });

  it('impide TaxonomySvcModule.forRoot({ databaseUrl }) en runtime productivo', () => {
    process.env.NODE_ENV = 'production';
    expect(() =>
      TaxonomySvcModule.forRoot({
        databaseUrl: 'postgresql://usuario:clave@localhost:5432/taxonomy',
      }),
    ).toThrow(
      'TaxonomySvcModule.forRoot con databaseUrl no está permitido en runtime productivo; use iniciarTaxonomySvc con Database y las garantías obligatorias de TLS e identidad.',
    );
  });

  it('permite crearRepositorioDrizzle en entorno de pruebas/desarrollo para preservar los tests de López', () => {
    process.env.NODE_ENV = 'test';
    const repo = crearRepositorioDrizzle(
      'postgresql://usuario:clave@localhost:5432/taxonomy',
    );
    expect(repo).toBeInstanceOf(DrizzleTaxonomyRepository);
    void repo.onApplicationShutdown();
  });

  it('permite proveedorDeRepositorio y forRoot en entorno test', () => {
    process.env.NODE_ENV = 'test';
    const provider = proveedorDeRepositorio(
      'postgresql://usuario:clave@localhost:5432/taxonomy',
    ) as any;
    expect(provider.provide).toBe(TAXONOMY_REPOSITORY);
    expect(typeof provider.useFactory).toBe('function');

    const dynamicModule = TaxonomySvcModule.forRoot({
      databaseUrl: 'postgresql://usuario:clave@localhost:5432/taxonomy',
    });
    expect(dynamicModule.module).toBe(TaxonomySvcModule);
  });
});
