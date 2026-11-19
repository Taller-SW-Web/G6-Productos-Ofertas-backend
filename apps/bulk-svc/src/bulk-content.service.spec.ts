import { createHash, randomUUID } from 'node:crypto';
import { BulkContentService } from './bulk-content.service.js';
import { BulkDomainError } from './domain/bulk.domain-error.js';

describe('Bulk private claim-check content service', () => {
  const contentId = randomUUID();
  const bytes = Buffer.from('{"rows":[]}', 'utf8');
  const repository = {
    findContentDocument: vi.fn(),
  };
  const storage = {
    get: vi.fn(),
  };
  const service = new BulkContentService(repository as never, storage as never);

  beforeEach(() => {
    vi.clearAllMocks();
    repository.findContentDocument.mockResolvedValue({
      contentId,
      contentRef: 'imports/opaque-private-object',
      byteLength: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      contentType: 'application/json',
    });
    storage.get.mockResolvedValue(bytes);
  });

  it('returns the exact stored bytes and their verified digest', async () => {
    await expect(service.download(contentId)).resolves.toEqual({
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    expect(storage.get).toHaveBeenCalledWith('imports/opaque-private-object');
  });

  it.each([
    ['same-length tampered bytes', Buffer.from('{"rows":""}', 'utf8')],
    ['truncated bytes', bytes.subarray(0, bytes.length - 1)],
  ])('fails closed for %s', async (_caseName, returnedBytes) => {
    storage.get.mockResolvedValue(returnedBytes);
    await expect(service.download(contentId)).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    });
  });

  it('uses a uniform not-found result for malformed or missing opaque IDs', async () => {
    repository.findContentDocument.mockResolvedValue(null);
    await expect(service.download('not-a-uuid')).rejects.toMatchObject({
      code: 'ARCHIVO_NO_ENCONTRADO',
    });
    await expect(service.download(contentId)).rejects.toBeInstanceOf(
      BulkDomainError,
    );
    expect(repository.findContentDocument).toHaveBeenCalledTimes(1);
  });
});
