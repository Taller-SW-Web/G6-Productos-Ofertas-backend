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

  function reference(documentBytes = bytes) {
    return {
      content_id: randomUUID(),
      sha256: createHash('sha256').update(documentBytes).digest('hex'),
      byte_length: documentBytes.length,
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

  it('rejects same-length tampered bytes even when headers match the reference', async () => {
    const tampered = Buffer.from('{"rows":""}', 'utf8');
    expect(tampered).toHaveLength(bytes.length);
    fetchMock.mockImplementation(
      async () =>
        new Response(tampered, {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'content-length': String(bytes.length),
            'x-content-sha256': digest,
          },
        }),
    );
    await expect(client().getDocument(reference())).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('accepts content larger than 256 KiB when length and SHA-256 match', async () => {
    const large = Buffer.from(JSON.stringify({ rows: ['x'.repeat(300 * 1024)] }));
    const ref = reference(large);
    fetchMock.mockResolvedValue(new Response(large, { status: 200, headers: {
      'content-type': 'application/json', 'content-length': String(large.length),
      'x-content-sha256': ref.sha256,
    } }));
    await expect(client().getDocument(ref)).resolves.toEqual({ rows: ['x'.repeat(300 * 1024)] });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([401, 403, 404] as const)('rejects explicit HTTP %s without retry', async status => {
    fetchMock.mockResolvedValue(new Response(null, { status }));
    await expect(client().getDocument(reference())).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('retries 503 and network timeout, then fails closed', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    await expect(client().getDocument(reference())).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(3);

    fetchMock.mockReset().mockRejectedValue(new DOMException('timed out', 'AbortError'));
    await expect(client().getDocument(reference())).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('rejects corrupt JSON and mismatched declared length', async () => {
    const malformed = Buffer.from('{"rows":', 'utf8');
    const malformedRef = reference(malformed);
    fetchMock.mockResolvedValue(new Response(malformed, { status: 200, headers: {
      'content-type': 'application/json', 'content-length': String(malformed.length),
      'x-content-sha256': malformedRef.sha256,
    } }));
    await expect(client().getDocument(malformedRef)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('rejects a configured production service identity using non-HTTPS or public origins', async () => {
    const previousEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      for (const origin of ['http://bulk-svc:3001', 'https://bulk-svc.example.com']) {
        process.env.CATALOG_BULK_CONTENTS_URL = origin;
        await expect(client().getDocument(reference())).rejects.toThrow();
      }
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      if (previousEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousEnv;
    }
  });
});
