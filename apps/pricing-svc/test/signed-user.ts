import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Proveedor JWKS HTTP real, exclusivamente para las suites aisladas.
export class SignedUser {
  private readonly pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  private server?: Server;
  issuer = '';
  readonly actorId = '74ed2f19-7e70-4915-a6f6-bbc691b82587';
  readonly jwk = {
    ...this.pair.publicKey.export({ format: 'jwk' }),
    kid: 'pricing-fixture',
    use: 'sig',
    alg: 'RS256',
  };

  async start(
    withServiceToken = false,
    introspect?: (token: string) => boolean,
  ): Promise<void> {
    this.server = createServer(async (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.setHeader('Cache-Control', 'public, max-age=60');
      if (withServiceToken && request.url === '/api/v1/auth/token') {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const params = new URLSearchParams(Buffer.concat(chunks).toString());
        const scope = params.get('scope') ?? '';
        response.end(
          JSON.stringify({
            tokenType: 'Bearer',
            accessToken: this.token({
              sub: 'modulo-productos',
              tipo: 'servicio',
              aud:
                scope === 'tokens:introspeccion'
                  ? 'api-seguridad'
                  : 'api-productos',
              scope,
            }),
            expiresIn: 60,
            scopes: [scope],
          }),
        );
        return;
      }
      if (introspect && request.url === '/api/v1/auth/introspeccion') {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const { token } = JSON.parse(Buffer.concat(chunks).toString()) as {
          token: string;
        };
        response.end(
          JSON.stringify(
            introspect(token)
              ? {
                  activo: true,
                  sub: this.actorId,
                  roles: ['GESTOR_COMERCIAL'],
                  permisos: [],
                  tipo: 'acceso',
                }
              : { activo: false },
          ),
        );
        return;
      }
      response.end(JSON.stringify({ keys: [this.jwk] }));
    });
    await new Promise<void>((resolve) =>
      this.server!.listen(0, '127.0.0.1', resolve),
    );
    this.issuer = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    server?.closeAllConnections();
    if (server)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  }
  token(
    overrides: Record<string, unknown> = {},
    header: Record<string, unknown> = {},
  ) {
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const content = `${encode({ alg: 'RS256', kid: 'pricing-fixture', typ: 'JWT', ...header })}.${encode(
      {
        iss: this.issuer,
        sub: this.actorId,
        tipo: 'acceso',
        iat: now,
        exp: now + 300,
        jti: randomUUID(),
        roles: ['GESTOR_COMERCIAL'],
        ...overrides,
      },
    )}`;
    return `${content}.${sign('RSA-SHA256', Buffer.from(content), this.pair.privateKey).toString('base64url')}`;
  }
}
