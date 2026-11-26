import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { CatalogPricingIdentityProvider } from './catalog-pricing-identity.js';

export const CATALOG_BULK_CONTENT_MAX_BYTES = 50 * 1024 * 1024;

function bulkOrigin(env: Record<string, string | undefined> = process.env) {
  const raw = env.CATALOG_BULK_CONTENTS_URL;
  if (!raw || raw !== raw.trim()) throw new ServiceUnavailableException();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ServiceUnavailableException();
  }
  const loopback =
    env.NODE_ENV === 'test' &&
    url.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const azureInternal =
    url.protocol === 'https:' &&
    url.port === '' &&
    /^bulk-svc\.internal(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?){2,}\.azurecontainerapps\.io$/.test(
      url.hostname,
    );
  if (
    (!loopback && !azureInternal) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new ServiceUnavailableException();
  return url.origin;
}

async function readBytes(response: Response, expectedLength: number) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('missing response body');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > CATALOG_BULK_CONTENT_MAX_BYTES || length > expectedLength)
        throw new Error('content length exceeded');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (length !== expectedLength) throw new Error('content length mismatch');
  return Buffer.concat(chunks, length);
}

export interface CatalogBulkContentReference {
  content_id: string;
  sha256: string;
  byte_length: number;
  content_type: 'application/json';
}

@Injectable()
export class CatalogBulkContentIdentity extends CatalogPricingIdentityProvider {
  protected override get clientId() {
    return 'catalog-svc';
  }
  protected override get scope() {
    return 'carga-masiva:contenidos:leer';
  }
  protected override get credentials() {
    return this.config?.bulkContentCredentials;
  }
}

@Injectable()
export class CatalogBulkContentClient {
  constructor(private readonly identity: CatalogBulkContentIdentity) {}

  async getDocument(reference: CatalogBulkContentReference): Promise<unknown> {
    const origin = bulkOrigin();
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = AbortSignal.timeout(15_000);
      try {
        const authorization = await this.identity.authorization(controller);
        const response = await fetch(
          `${origin}/interno/carga-masiva/contenidos/${encodeURIComponent(reference.content_id)}`,
          {
            redirect: 'error',
            signal: controller,
            headers: {
              authorization,
              accept: 'application/json',
            },
          },
        );
        if ([429, 500, 502, 503, 504].includes(response.status)) {
          await response.body?.cancel();
          throw new Error('temporary content service failure');
        }
        if (response.status !== 200) {
          console.error(`[catalog-bulk-content] GET ${origin}/interno/carga-masiva/contenidos/${reference.content_id} -> status=${response.status}`);
          await response.body?.cancel();
          throw new ServiceUnavailableException();
        }
        const lengthHeader = response.headers.get('content-length');
        const digestHeader = response.headers.get('x-content-sha256');
        if (
          response.headers.get('content-type')?.split(';')[0] !==
            'application/json' ||
          !lengthHeader ||
          !/^\d+$/.test(lengthHeader) ||
          Number(lengthHeader) !== reference.byte_length ||
          digestHeader !== reference.sha256 ||
          reference.byte_length > CATALOG_BULK_CONTENT_MAX_BYTES
        ) {
          await response.body?.cancel();
          throw new Error('content headers mismatch');
        }
        const bytes = await readBytes(response, reference.byte_length);
        if (
          createHash('sha256').update(bytes).digest('hex') !== reference.sha256
        )
          throw new Error('content digest mismatch');
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        return JSON.parse(text) as unknown;
      } catch (error) {
        lastError = error;
        if (error instanceof ServiceUnavailableException) throw error;
        if (attempt < 2)
          await new Promise((resolve) =>
            setTimeout(resolve, 100 * 2 ** attempt),
          );
      }
    }
    void lastError;
    throw new ServiceUnavailableException();
  }
}
