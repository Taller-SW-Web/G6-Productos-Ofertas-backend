import { EXPECTED_AUDIENCE } from './auth.constants.js';

export interface CreateTestTokenOptions {
  clientId?: string;
  sub?: string;
  aud?: string | string[];
  scope?: string;
  scopes?: string[];
  expiresInSeconds?: number;
  exp?: number;
}

export function createTestJwt(options: CreateTestTokenOptions = {}): string {
  const header = {
    alg: 'HS256',
    typ: 'JWT',
  };

  const nowSec = Math.floor(Date.now() / 1000);
  const exp =
    options.exp !== undefined
      ? options.exp
      : nowSec + (options.expiresInSeconds ?? 3600);

  const payload = {
    sub: options.sub ?? options.clientId ?? 'modulo-ventas',
    client_id: options.clientId ?? options.sub ?? 'modulo-ventas',
    aud: options.aud !== undefined ? options.aud : EXPECTED_AUDIENCE,
    scope:
      options.scope ??
      'inventario:reservar inventario:consumir inventario:liberar inventario:operaciones:leer inventario:disponibilidad:leer',
    exp,
    iat: nowSec,
  };

  const toBase64Url = (obj: Record<string, unknown>): string =>
    Buffer.from(JSON.stringify(obj))
      .toString('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');

  const encodedHeader = toBase64Url(header);
  const encodedPayload = toBase64Url(payload);
  const dummySignature = 'test_signature';

  return `${encodedHeader}.${encodedPayload}.${dummySignature}`;
}
