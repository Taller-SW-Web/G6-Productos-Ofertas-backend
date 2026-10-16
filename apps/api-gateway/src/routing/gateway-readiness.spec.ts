import { GatewayReadiness } from './gateway-readiness.js';
import { readGatewaySettings } from './gateway-settings.js';

describe('Readiness for enabled dependencies only (H-03)', () => {
  const settings = readGatewaySettings({
    GATEWAY_CATALOG_SVC_URL: 'http://catalog.internal:3001',
    GATEWAY_CATALOG_SVC_READINESS_PATH: '/health/ready',
    GATEWAY_TIMEOUT_MS: '20',
  });
  afterEach(() => vi.unstubAllGlobals());
  it('keeps a complete inventory while accepting verified, healthy partial deployment', async () => {
    const remote = vi.fn(
      async () =>
        new Response('{"status":"ready"}', {
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', remote);
    expect(await new GatewayReadiness(settings).check()).toMatchObject({
      status: 'ready',
      coverage: 'partial',
      dependencies: { 'catalog-svc': 'ready', 'bulk-svc': 'not_configured' },
    });
    expect(remote.mock.calls).toHaveLength(1);
  });
  it.each([
    [200, '{"status":"ok"}'],
    [200, '{}'],
    [200, '{"status":"not_ready"}'],
    [200, 'invalid json'],
    [200, 'x'.repeat(16385)],
    [404, '{}'],
    [503, '{}'],
  ])(
    'fails closed for status %s/body without verified readiness',
    async (status, body) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(body, {
              status,
              headers: { 'content-type': 'application/json' },
            }),
        ),
      );
      expect((await new GatewayReadiness(settings).check()).status).toBe(
        'not_ready',
      );
    },
  );
  it('does not call guessed paths or liveness when readiness has not been confirmed', async () => {
    const remote = vi.fn();
    vi.stubGlobal('fetch', remote);
    const unverified = readGatewaySettings({
      GATEWAY_CATALOG_SVC_URL: 'http://catalog.internal:3001',
    });
    expect(await new GatewayReadiness(unverified).check()).toMatchObject({
      status: 'not_ready',
      dependencies: { 'catalog-svc': 'unverified' },
    });
    expect(
      (await new GatewayReadiness(readGatewaySettings({})).check()).status,
    ).toBe('not_ready');
    expect(remote).not.toHaveBeenCalled();
  });
  it('does not let one healthy dependency hide another unavailable dependency', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) => {
        if (url.hostname === 'catalog.internal')
          return new Response('{"status":"ready"}', {
            headers: { 'content-type': 'application/json' },
          });
        throw new Error('private-url-or-secret');
      }),
    );
    const result = await new GatewayReadiness({
      ...settings,
      upstreams: {
        ...settings.upstreams,
        'bulk-svc': 'http://bulk.internal:3008',
      },
      readinessPaths: {
        ...settings.readinessPaths,
        'bulk-svc': '/health/ready',
      },
    }).check();
    expect(result).toMatchObject({
      status: 'not_ready',
      dependencies: { 'catalog-svc': 'ready', 'bulk-svc': 'not_ready' },
    });
    expect(JSON.stringify(result)).not.toMatch(/private|internal|secret/);
  });
  it('bounds a hanging dependency by the configured deadline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener(
              'abort',
              () => reject(new Error('timeout')),
              { once: true },
            );
          }),
      ),
    );
    expect((await new GatewayReadiness(settings).check()).status).toBe(
      'not_ready',
    );
  });
});
