import { createHash } from 'node:crypto';
import { BulkContentService } from './bulk-content.service.js';

describe('BulkContentService', () => {
  const contentId = '6fba7e20-2f86-4c70-9ca8-490c75c06c77';
  const bytes = Buffer.from('{"rows":[{"sku":"SKU-1"}]}', 'utf8');
  const digest = createHash('sha256').update(bytes).digest('hex');

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
      batchId: '6fba7e20-2f86-4c70-9ca8-490c75c06c77',
      batchOperationId: '6fba7e20-2f86-4c70-9ca8-490c75c06c77',
      contentRef: 'supabase://private-bucket/imports/object.json',
      sha256: digest,
      byteLength: bytes.length,
      contentType: 'application/json',
    });
    storage.get.mockResolvedValue(bytes);
  });

  it('returns the original UTF-8 bytes and their verified digest', async () => {
    const result = await service.download(contentId);

    expect(result.bytes).toEqual(bytes);
    expect(result.sha256).toBe(digest);
    expect(storage.get).toHaveBeenCalledWith(
      'supabase://private-bucket/imports/object.json',
    );
  });

  it('does not expose Storage references for invalid or unknown content IDs', async () => {
    await expect(service.download('not-a-uuid')).rejects.toMatchObject({
      code: 'ARCHIVO_NO_ENCONTRADO',
    });
    expect(repository.findContentDocument).not.toHaveBeenCalled();

    repository.findContentDocument.mockResolvedValueOnce(null);
    await expect(service.download(contentId)).rejects.toMatchObject({
      code: 'ARCHIVO_NO_ENCONTRADO',
    });
    expect(storage.get).not.toHaveBeenCalled();
  });

  it.each([
    ['byte length mismatch', Buffer.concat([bytes, Buffer.from(' ')])],
    ['digest mismatch', Buffer.from('{"rows":[]}')],
  ])(
    'rejects corrupted claim-check bytes with a sanitized storage error (%s)',
    async (_case, corrupted) => {
      storage.get.mockResolvedValueOnce(corrupted);

      await expect(service.download(contentId)).rejects.toMatchObject({
        code: 'STORAGE_UNAVAILABLE',
      });
    },
  );

  it('maps an unavailable or timed-out Storage read to a sanitized error', async () => {
    storage.get.mockRejectedValueOnce(
      new Error('private storage timeout with credentials'),
    );

    await expect(service.download(contentId)).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    });
  });

  it('does not serve documents persisted with another content type', async () => {
    repository.findContentDocument.mockResolvedValueOnce({
      contentId,
      contentRef: 'private://must-not-be-returned',
      sha256: digest,
      byteLength: bytes.length,
      contentType: 'text/plain',
    });

    await expect(service.download(contentId)).rejects.toMatchObject({
      code: 'ARCHIVO_NO_ENCONTRADO',
    });
    expect(storage.get).not.toHaveBeenCalled();
  });
});
