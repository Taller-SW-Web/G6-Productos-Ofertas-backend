import {
  CatalogPersistenceError,
  translatePostgresFailure,
} from './database-errors.js';

describe('safe PostgreSQL failure translation', () => {
  it.each([
    ['23505', false, 'unique'],
    ['23503', false, 'foreign_key'],
    ['23514', false, 'check'],
    ['40001', false, 'serialization'],
    ['40P01', false, 'deadlock'],
    ['08006', false, 'connection'],
    ['ECONNRESET', false, 'connection'],
    ['53300', false, 'connection'],
    ['23514', true, 'deferred_constraint'],
  ] as const)(
    'classifies SQLSTATE %s at commit=%s',
    (code, commit, expected) => {
      const error = Object.assign(new Error('private SQL and password'), {
        code,
        constraint: 'catalog_internal_guard',
      });
      const translated = translatePostgresFailure(error, commit);
      expect(translated).toBeInstanceOf(CatalogPersistenceError);
      expect(translated.failure).toBe(expected);
      expect(translated.sqlState).toBe(
        /^[0-9A-Z]{5}$/.test(code) ? code : undefined,
      );
      expect(translated.constraintName).toBe('catalog_internal_guard');
      expect(translated.message).not.toContain('private SQL');
      expect(translated.message).not.toContain('password');
      expect(translated.getStatus()).toBe(503);
    },
  );

  it('does not retain arbitrary driver text or SQL parameters', () => {
    const translated = translatePostgresFailure(
      Object.assign(
        new Error('SELECT secret FROM catalog WHERE token=password'),
        {
          code: 'XXXXX',
          detail: 'sensitive parameter value',
        },
      ),
    );
    expect(translated.failure).toBe('other');
    expect(JSON.stringify(translated)).not.toContain('secret');
    expect(translated.message).toBe('Servicio temporalmente no disponible');
  });
});
