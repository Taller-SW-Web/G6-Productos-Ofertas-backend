import { createHash, randomUUID } from 'node:crypto';
import { CatalogBulkContentClient } from './catalog-bulk-content.js';

describe('Catalog private Bulk V3 claim-check client', () => {
  const previous = {
    nodeEnv: process.env.NODE_ENV,
    origin: process.env.CATALOG_BULK_CONTENTS_URL,
  };
  const bytes = Buffer.from('{"rows":[]}', 'utf8');
  const digest = createHash('sha256').update(bytes).digest('hex');
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.CATALOG_BULK_CONTENTS_URL = 'http://127.0.0.1:3001';
    fetchMock = vi.fn().mockResolvedValue(
      new Response(bytes, {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-length': String(bytes.length),
          'x-content-sha256': digest,
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (previous.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous.nodeEnv;
    if (previous.origin === undefined)
      delete process.env.CATALOG_BULK_CONTENTS_URL;
    else process.env.CATALOG_BULK_CONTENTS_URL = previous.origin;
  });

  function client() {
    return new CatalogBulkContentClient({
      authorization: vi.fn().mockResolvedValue('Bearer test-service-token'),
    } as never);
  }

  function reference() {
    return {
      content_id: randomUUID(),
      sha256: digest,
      byte_length: bytes.length,
      content_type: 'application/json' as const,
    };
  }

  it('downloads through the configured private origin with service identity and validates the bytes', async () => {
    await expect(client().getDocument(reference())).resolves.toEqual({
      rows: [],
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(
      /^http:\/\/127\.0\.0\.1:3001\/interno\/carga-masiva\/contenidos\//,
    );
    expect(options.redirect).toBe('error');
    expect(new Headers(options.headers).get('authorization')).toBe(
      'Bearer test-service-token',
    );
    expect(new Headers(options.headers).get('accept')).toBe('application/json');
  });

  it('rejects mismatched content length and digest headers after bounded retries', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(bytes, {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'content-length': String(bytes.length + 1),
            'x-content-sha256': '0'.repeat(64),
          },
        }),
    );
    await expect(client().getDocument(reference())).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
