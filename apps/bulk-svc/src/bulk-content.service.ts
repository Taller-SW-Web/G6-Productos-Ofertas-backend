import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { BulkDomainError } from './domain/bulk.domain-error.js';
import { BulkPersistenceRepository } from './persistence/bulk.repository.js';
import { BulkStorageService } from './storage/bulk-storage.service.js';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class BulkContentService {
  constructor(
    private readonly repository: BulkPersistenceRepository,
    private readonly storage: BulkStorageService,
  ) {}

  async download(
    contentId: string,
  ): Promise<{ bytes: Buffer; sha256: string }> {
    if (!UUID.test(contentId)) throw this.notFound();
    const document = await this.repository.findContentDocument(contentId);
    if (!document || document.contentType !== 'application/json')
      throw this.notFound();
    try {
      const bytes = await this.storage.get(document.contentRef);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (
        bytes.length !== document.byteLength ||
        sha256 !== document.sha256 ||
        bytes.length < 1
      )
        throw new Error('claim-check integrity failure');
      return { bytes, sha256 };
    } catch {
      throw new BulkDomainError(
        'STORAGE_UNAVAILABLE',
        'El contenido privado no está disponible.',
      );
    }
  }

  private notFound() {
    return new BulkDomainError(
      'ARCHIVO_NO_ENCONTRADO',
      'El contenido solicitado no existe.',
    );
  }
}
