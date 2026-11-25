import { createVerify } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { trustedJwksPublicKey, JwksUnavailable } from './trusted-jwks.js';

const REQUIRED_SCOPE = 'carga-masiva:contenidos:leer';
const ALLOWED_CLIENT = 'catalog-svc';

function tokenStrings(value: unknown): string[] | undefined {
  if (typeof value === 'string') return value.split(/\s+/).filter(Boolean);
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === 'string')
    ? value
    : undefined;
}

@Injectable()
export class BulkServiceBearerGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (
      (process.env.G6_SECURITY_MODE ?? 'G7_AUTHENTICATED') !==
      'G7_AUTHENTICATED'
    )
      throw new UnauthorizedException('TOKEN_INVALIDO');
    const request = context.switchToHttp().getRequest<Request>();
    const authorization = request.headers.authorization;
    const match =
      typeof authorization === 'string' &&
      /^Bearer ([A-Za-z0-9._~-]+)$/.exec(authorization);
    if (!match) throw new UnauthorizedException('TOKEN_INVALIDO');
    const token = match[1]!;
    const parts = token.split('.');
    if (parts.length !== 3) throw new UnauthorizedException('TOKEN_INVALIDO');

    let header: Record<string, unknown>;
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
      if (
        !header ||
        typeof header !== 'object' ||
        Array.isArray(header) ||
        !claims ||
        typeof claims !== 'object' ||
        Array.isArray(claims)
      )
        throw new Error();
    } catch {
      throw new UnauthorizedException('TOKEN_INVALIDO');
    }

    const issuer = process.env.G7_JWT_ISSUER;
    if (header.alg !== 'RS256' || !issuer)
      throw new UnauthorizedException('TOKEN_INVALIDO');
    try {
      const jwksUrl = process.env.G7_JWT_JWKS_URL;
      const key = jwksUrl
        ? await trustedJwksPublicKey(token, jwksUrl, process.env.NODE_ENV)
        : (process.env.G7_JWT_PUBLIC_KEY ?? process.env.JWT_PUBLIC_KEY);
      if (!key) throw new JwksUnavailable();
      const verifier = createVerify('RSA-SHA256');
      verifier.update(parts[0] + '.' + parts[1]);
      if (
        !verifier.verify(
          key.replace(/\\n/g, '\n'),
          Buffer.from(parts[2]!, 'base64url'),
        )
      )
        throw new Error();
    } catch (error) {
      if (error instanceof JwksUnavailable)
        throw new ServiceUnavailableException({
          code: 'SERVICIO_NO_DISPONIBLE',
        });
      throw new UnauthorizedException('TOKEN_INVALIDO');
    }

    const now = Math.floor(Date.now() / 1000);
    const audiences = tokenStrings(claims.aud);
    const scopes = tokenStrings(claims.scope);
    const client = claims.client_id ?? claims.azp ?? claims.sub;
    if (
      claims.iss !== issuer ||
      claims.tipo !== 'servicio' ||
      typeof client !== 'string' ||
      typeof claims.sub !== 'string' ||
      !Number.isSafeInteger(claims.iat) ||
      (claims.iat as number) > now ||
      !Number.isSafeInteger(claims.exp) ||
      (claims.exp as number) <= now ||
      typeof claims.jti !== 'string' ||
      !claims.jti.trim() ||
      (claims.nbf !== undefined &&
        (!Number.isSafeInteger(claims.nbf) || (claims.nbf as number) > now)) ||
      !audiences ||
      !audiences.includes('api-productos') ||
      !scopes
    )
      throw new UnauthorizedException('TOKEN_INVALIDO');
    if (client !== ALLOWED_CLIENT || !scopes.includes(REQUIRED_SCOPE))
      throw new ForbiddenException('SCOPE_INSUFICIENTE');
    return true;
  }
}
