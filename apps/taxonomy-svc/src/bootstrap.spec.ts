import { readHttpConfig } from './bootstrap.js';
describe('Taxonomy bootstrap configuration reconciled with López', () => {
  it('defaults to loopback and supports Docker binding and PORT fallback', () => {
    expect(readHttpConfig({})).toEqual({ host: '127.0.0.1', port: 3006 });
    expect(
      readHttpConfig({
        NODE_ENV: 'production',
        TAXONOMY_SVC_HOST: '0.0.0.0',
        PORT: '3016',
      }),
    ).toEqual({ host: '0.0.0.0', port: 3016 });
  });
  it.each(['0', '65536', 'abc', '1.5', ' 3006', 'Infinity'])(
    'rejects invalid port %s',
    (value) => {
      expect(() => readHttpConfig({ TAXONOMY_SVC_PORT: value })).toThrow();
    },
  );
  it('rejects invalid environment without returning its value', () => {
    expect(() => readHttpConfig({ NODE_ENV: 'private-secret' })).toThrow(
      'Configuración HTTP taxonomy inválida',
    );
  });
});
