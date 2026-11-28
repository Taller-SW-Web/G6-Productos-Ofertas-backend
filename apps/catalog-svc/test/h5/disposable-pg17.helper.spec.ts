import { describe, it, expect } from 'vitest';
import { readSafeDisposablePg17Settings } from './disposable-pg17.helper.js';

describe('H33 — Regresiones negativas de disposable-pg17.helper (configuraciones inseguras)', () => {
  it('rechaza hosts remotos o compartidos (como Supabase o IPs no loopback)', () => {
    expect(() =>
      readSafeDisposablePg17Settings({
        PGHOST: 'db.shared-supabase.example.com',
        PGPORT: '55432',
        PGDATABASE: 'h5_catalog_isolated',
        PGUSER: 'catalog_app',
      }),
    ).toThrow(/H26 SEGURIDAD.*Host PostgreSQL no autorizado/);
  });

  it('rechaza bases de datos sin sufijo dedicado *_isolated', () => {
    expect(() =>
      readSafeDisposablePg17Settings({
        PGHOST: '127.0.0.1',
        PGPORT: '55432',
        PGDATABASE: 'postgres',
        PGUSER: 'catalog_app',
      }),
    ).toThrow(/H26 SEGURIDAD.*patron dedicado/);
  });

  it('rechaza roles superuser o propietarios (postgres, po_catalog_owner)', () => {
    for (const unsafeRole of ['postgres', 'po_catalog_owner', 'admin']) {
      expect(() =>
        readSafeDisposablePg17Settings({
          PGHOST: '127.0.0.1',
          PGPORT: '55432',
          PGDATABASE: 'h5_catalog_isolated',
          PGUSER: unsafeRole,
        }),
      ).toThrow(/H26 SEGURIDAD.*rol runtime no propietario/);
    }
  });

  it('rechaza puertos fuera de rango no privilegiado', () => {
    expect(() =>
      readSafeDisposablePg17Settings({
        PGHOST: '127.0.0.1',
        PGPORT: '80',
        PGDATABASE: 'h5_catalog_isolated',
        PGUSER: 'catalog_app',
      }),
    ).toThrow(/H26 SEGURIDAD.*Puerto PostgreSQL invalido/);
  });

  it('acepta configuracion segura loopback + *_isolated + rol runtime catalog_app', () => {
    const settings = readSafeDisposablePg17Settings({
      PGHOST: '127.0.0.1',
      PGPORT: '55432',
      PGDATABASE: 'h5_catalog_newman_isolated',
      PGUSER: 'catalog_app',
      PGPASSWORD: 'app_pass_synthetic',
    });
    expect(settings.database).toBe('h5_catalog_newman_isolated');
    expect(settings.expectedRole).toBe('catalog_app');
    expect(settings.pool.host).toBe('127.0.0.1');
    expect(settings.pool.port).toBe(55432);
  });
});
