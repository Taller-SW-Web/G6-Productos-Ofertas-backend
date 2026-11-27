import {
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CatalogConfig } from './config.js';
import { CatalogTokenVerifier } from './catalog-auth.js';
import type { CatalogPricingIdentity } from './catalog-price-filter.js';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export class CatalogIdentityAcquisitionError extends Error {
  constructor(readonly classification: 'TRANSIENT' | 'PERMANENT' | 'UNKNOWN') {
    super(`CATALOG_IDENTITY_${classification}`);
  }
}
async function json(response: Response) {
  if (
    response.status !== 200 ||
    response.headers.get('content-type')?.split(';')[0] !== 'application/json'
  ) {
    await response.body?.cancel();
    throw new Error();
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 65536) throw new Error();
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
async function aborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let rejectAbort!: () => void;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(new ServiceUnavailableException());
    signal.addEventListener('abort', rejectAbort, { once: true });
  });
  try {
    return await Promise.race([work, cancellation]);
  } finally {
    signal.removeEventListener('abort', rejectAbort);
  }
}
@Injectable()
export class CatalogPricingIdentityProvider implements CatalogPricingIdentity {
  protected get clientId(): string {
    return 'modulo-productos';
  }
  protected get scope(): string {
    return 'precios:leer';
  }
  private cached?: { authorization: string; expiresAt: number };
  private loading?: Promise<{ authorization: string; expiresAt: number }>;
  constructor(
    @Optional()
    @Inject(CatalogConfig)
    protected readonly config: CatalogConfig | undefined,
    private readonly verifier: CatalogTokenVerifier,
  ) {}
  protected get credentials() {
    return this.config?.serviceCredentials;
  }
  private async issue() {
    const credentials = this.credentials;
    if (!credentials || !this.config?.security) {
      console.error(
        `[catalog-identity] missing credentials or security for ${this.clientId} scope=${this.scope}`,
      );
      throw new ServiceUnavailableException();
    }
    const signal = AbortSignal.timeout(5000);
    const request = async () => {
      const response = await fetch(credentials.tokenUrl, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.clientId,
          client_secret: credentials.clientSecret,
          scope: this.scope,
        }).toString(),
      });
      if (response.status === 503) {
        await response.body?.cancel();
        throw new CatalogIdentityAcquisitionError('TRANSIENT');
      }
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        throw new CatalogIdentityAcquisitionError('PERMANENT');
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new CatalogIdentityAcquisitionError('UNKNOWN');
      }
      const body = await json(response);
      if (
        !record(body) ||
        typeof body.accessToken !== 'string' ||
        body.tokenType !== 'Bearer' ||
        !Number.isSafeInteger(body.expiresIn) ||
        (body.expiresIn as number) <= 0 ||
        !Array.isArray(body.scopes) ||
        !body.scopes.every((s) => typeof s === 'string') ||
        !body.scopes.includes(this.scope)
      )
        throw new CatalogIdentityAcquisitionError('PERMANENT');
      const principal = await this.verifier.verify(body.accessToken);
      const grantedScopes = body.scopes;
      if (
        principal.kind !== 'service' ||
        principal.subject !== this.clientId ||
        !principal.audiences.includes('api-productos') ||
        !principal.scopes.includes(this.scope) ||
        principal.scopes.length !== body.scopes.length ||
        principal.scopes.some((s) => !grantedScopes.includes(s))
      )
        throw new Error();
      // exp is read for cache lifetime only after signature, issuer and claims verification.
      const claims: unknown = JSON.parse(
        Buffer.from(body.accessToken.split('.')[1]!, 'base64url').toString(
          'utf8',
        ),
      );
      if (!record(claims) || typeof claims.exp !== 'number')
        throw new CatalogIdentityAcquisitionError('PERMANENT');
      const now = Date.now(),
        lifetime = Math.min(
          (body.expiresIn as number) * 1000,
          claims.exp * 1000 - now,
        );
      if (!Number.isFinite(lifetime) || lifetime <= 0)
        throw new CatalogIdentityAcquisitionError('PERMANENT');
      signal.throwIfAborted();
      return {
        authorization: 'Bearer ' + body.accessToken,
        expiresAt: now + lifetime - Math.min(30000, lifetime / 10),
      };
    };
    try {
      return await aborted(request(), signal);
    } catch (error) {
      console.error(
        `[catalog-identity] failed for ${this.clientId} scope=${this.scope}:`,
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      );
      if (error instanceof CatalogIdentityAcquisitionError) throw error;
      if (
        signal.aborted &&
        signal.reason instanceof Error &&
        ['AbortError', 'TimeoutError'].includes(signal.reason.name)
      )
        throw new CatalogIdentityAcquisitionError('TRANSIENT');
      if (
        error instanceof Error &&
        ['AbortError', 'TimeoutError'].includes(error.name)
      )
        throw new CatalogIdentityAcquisitionError('TRANSIENT');
      throw new CatalogIdentityAcquisitionError('UNKNOWN');
    }
  }
  async authorization(signal: AbortSignal): Promise<string> {
    try {
      signal.throwIfAborted();
      if (this.cached && this.cached.expiresAt > Date.now())
        return this.cached.authorization;
      if (!this.loading)
        this.loading = this.issue()
          .then((value) => {
            this.cached = value;
            return value;
          })
          .finally(() => {
            this.loading = undefined;
          });
      return (await aborted(this.loading, signal)).authorization;
    } catch {
      throw new ServiceUnavailableException();
    }
  }
  async authorizationForBulkRetry(signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    if (this.cached && this.cached.expiresAt > Date.now())
      return this.cached.authorization;
    if (!this.loading)
      this.loading = this.issue()
        .then((value) => {
          this.cached = value;
          return value;
        })
        .finally(() => {
          this.loading = undefined;
        });
    try {
      return (await aborted(this.loading, signal)).authorization;
    } catch (error) {
      console.error(
        `[catalog-identity] failed for ${this.clientId} scope=${this.scope}:`,
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      );
      if (error instanceof CatalogIdentityAcquisitionError) throw error;
      if (
        error instanceof Error &&
        ['AbortError', 'TimeoutError'].includes(error.name)
      )
        throw new CatalogIdentityAcquisitionError('TRANSIENT');
      throw new CatalogIdentityAcquisitionError('UNKNOWN');
    }
  }
}
