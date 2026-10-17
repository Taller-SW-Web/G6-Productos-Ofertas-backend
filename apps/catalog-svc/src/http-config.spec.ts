import { readHttpConfig } from './http-config.js';
describe('Catalog HTTP binding', () => {
  it('defaults to loopback and allows Docker binding and PORT fallback', () => {
    expect(readHttpConfig({})).toEqual({ host: '127.0.0.1', port: 3001 });
    expect(
      readHttpConfig({ CATALOG_SVC_HOST: '0.0.0.0', PORT: '3011' }),
    ).toEqual({ host: '0.0.0.0', port: 3011 });
  });
  it.each(['0', '65536', 'abc', '1.5', ' 3001', 'Infinity'])(
    'rejects invalid port %s',
    (value) => {
      expect(() => readHttpConfig({ CATALOG_SVC_PORT: value })).toThrow();
    },
  );
  it('rejects an invalid binding', () => {
    expect(() =>
      readHttpConfig({ CATALOG_SVC_HOST: 'http://localhost' }),
    ).toThrow();
  });
});
