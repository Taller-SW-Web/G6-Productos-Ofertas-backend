import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  REQUIRED_SCOPE_KEY,
  ALLOWED_CLIENTS_KEY,
  EXPECTED_AUDIENCE,
} from './auth.constants.js';
import { ProblemDetailsException } from '../errors/inventory.errors.js';

export interface DecodedTokenPayload {
  sub?: string;
  client_id?: string;
  aud?: string | string[];
  scope?: string;
  scopes?: string[];
  exp?: number;
  iat?: number;
  iss?: string;
  [key: string]: unknown;
}

@Injectable()
export class InventoryAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredScope = this.reflector.getAllAndOverride<string | undefined>(
      REQUIRED_SCOPE_KEY,
      [context.getHandler(), context.getClass()],
    );

    const allowedClients = this.reflector.getAllAndOverride<
      string[] | undefined
    >(ALLOWED_CLIENTS_KEY, [context.getHandler(), context.getClass()]);

    const request = context.switchToHttp().getRequest();
    const correlationId =
      request.headers['x-correlation-id'] || request.headers['correlation-id'];

    const authHeader = request.headers['authorization'];
    if (!authHeader || typeof authHeader !== 'string') {
      throw ProblemDetailsException.tokenInvalido(
        'Encabezado Authorization requerido con formato Bearer <token>',
        correlationId,
      );
    }

    if (!authHeader.startsWith('Bearer ')) {
      throw ProblemDetailsException.tokenInvalido(
        'Formato de autorización inválido. Debe ser Bearer <token>',
        correlationId,
      );
    }

    const rawToken = authHeader.substring(7).trim();
    if (!rawToken) {
      throw ProblemDetailsException.tokenInvalido(
        'Token Bearer ausente o vacío',
        correlationId,
      );
    }

    const payload = this.decodeToken(rawToken, correlationId);

    // 1. Verificación de expiración (exp)
    if (typeof payload.exp === 'number') {
      const nowSec = Math.floor(Date.now() / 1000);
      if (nowSec > payload.exp) {
        throw ProblemDetailsException.tokenInvalido(
          'Token JWT expirado',
          correlationId,
        );
      }
    }

    // 2. Verificación de audiencia (aud: 'api-productos')
    const audMatches =
      payload.aud === EXPECTED_AUDIENCE ||
      (Array.isArray(payload.aud) && payload.aud.includes(EXPECTED_AUDIENCE));

    if (!audMatches) {
      throw ProblemDetailsException.tokenInvalido(
        `Audiencia de token inválida. Se requiere '${EXPECTED_AUDIENCE}'`,
        correlationId,
      );
    }

    // 3. Verificación de clientes permitidos (client_id / sub)
    const clientId = payload.client_id || payload.sub;
    if (allowedClients && allowedClients.length > 0) {
      if (!clientId || !allowedClients.includes(clientId)) {
        throw ProblemDetailsException.scopeInsuficiente(
          `El cliente '${clientId || 'desconocido'}' no está autorizado para esta operación`,
          correlationId,
        );
      }
    }

    // 4. Verificación de scope
    if (requiredScope) {
      const scopes = new Set<string>();
      if (typeof payload.scope === 'string') {
        payload.scope
          .split(' ')
          .map((s) => s.trim())
          .filter(Boolean)
          .forEach((s) => scopes.add(s));
      }
      if (Array.isArray(payload.scopes)) {
        payload.scopes.forEach((s) => scopes.add(s));
      }

      if (!scopes.has(requiredScope)) {
        throw ProblemDetailsException.scopeInsuficiente(
          `Scope insuficiente. Se requiere '${requiredScope}'`,
          correlationId,
        );
      }
    }

    // Inyectar en el contexto de la solicitud
    request.user = payload;
    request.clientId = clientId;

    return true;
  }

  private decodeToken(
    rawToken: string,
    correlationId?: string,
  ): DecodedTokenPayload {
    const parts = rawToken.split('.');
    if (parts.length < 2) {
      throw ProblemDetailsException.tokenInvalido(
        'Formato de token JWT malformado (debe contener al menos header y payload)',
        correlationId,
      );
    }

    try {
      const payloadPart = parts[1];
      const base64 = payloadPart.replace(/-/g, '+').replace(/_/g, '/');
      const padLen = (4 - (base64.length % 4)) % 4;
      const paddedBase64 = base64 + '='.repeat(padLen);
      const jsonStr = Buffer.from(paddedBase64, 'base64').toString('utf8');
      return JSON.parse(jsonStr);
    } catch {
      throw ProblemDetailsException.tokenInvalido(
        'No se pudo decodificar el payload del token JWT',
        correlationId,
      );
    }
  }
}
