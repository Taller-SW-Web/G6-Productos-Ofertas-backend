import { readGatewaySettings } from './gateway-settings.js';
import { matchContractRoute } from './gateway-proxy.js';

describe('Gateway route boundaries and configuration', () => {
  it.each([
    'https://user:secret@host',
    'https://host/path',
    'https://host/?secret=1',
    'file:///private',
  ])('rejects unsafe upstream origin without exposing %s', (value) => {
    expect(() =>
      readGatewaySettings({ GATEWAY_CATALOG_SVC_URL: value }),
    ).toThrow('Invalid Gateway configuration');
    try {
      readGatewaySettings({ GATEWAY_CATALOG_SVC_URL: value });
    } catch (error) {
      expect(String(error)).not.toContain(value);
    }
  });
  it('does not permit a protected operation in the anonymous allowlist', () => {
    expect(() =>
      readGatewaySettings({ GATEWAY_PUBLIC_OPERATION_IDS: 'listarProductos' }),
    ).toThrow();
    expect(
      readGatewaySettings({ GATEWAY_PUBLIC_OPERATION_IDS: 'obtenerSeoPorSlug' })
        .publicOperations,
    ).toEqual(['obtenerSeoPorSlug']);
  });
  it('uses static paths before parameter paths and matches the exact method', () => {
    expect(
      matchContractRoute('GET', '/api/v1/promociones/administracion')
        ?.operationId,
    ).toBe('listarPromocionesAdmin');
    expect(
      matchContractRoute('GET', '/api/v1/productos/por-slug/zapatilla')
        ?.operationId,
    ).toBe('obtenerProductoPorSlug');
    expect(
      matchContractRoute('DELETE', '/api/v1/productos/abc'),
    ).toBeUndefined();
  });
  it.each([
    '/api/v1/productos/..',
    '/api/v1/productos/%2e%2e',
    '/api/v1/productos/%2fprivate',
    '/api/v1/productos/%5cprivate',
    '/api/v1/productos/%',
    '//other.test/api/v1/productos',
  ])('rejects traversal or ambiguous paths %s', (path) => {
    expect(matchContractRoute('GET', path)).toBeUndefined();
  });
});
