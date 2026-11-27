import { generateKeyPairSync, sign } from 'node:crypto';
import {
  Agent,
  createServer as createHttpsServer,
  request as httpsRequest,
} from 'node:https';
import { once } from 'node:events';
import {
  internalOperations,
  internalOrigin,
  InternalHttpReader,
} from '../infrastructure/http/internal-http.js';
import { G5CouponSnapshot } from './g5-coupon-snapshot.js';
import { consumptionName, type CouponCommand } from './coupon-command.js';

function derLen(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  const bytes: number[] = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derTag(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLen(content.length), content]);
}

function derSeq(...items: Buffer[]): Buffer {
  return derTag(0x30, Buffer.concat(items));
}

function derSet(...items: Buffer[]): Buffer {
  return derTag(0x31, Buffer.concat(items));
}

function derOid(oid: string): Buffer {
  const parts = oid.split('.').map(Number);
  const out = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const seg: number[] = [part & 0x7f];
    let v = part >> 7;
    while (v > 0) {
      seg.unshift((v & 0x7f) | 0x80);
      v >>= 7;
    }
    out.push(...seg);
  }
  return derTag(0x06, Buffer.from(out));
}

function derInt(value: number | Buffer): Buffer {
  const buf = typeof value === 'number' ? Buffer.from([value]) : value;
  const padded = buf[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf;
  return derTag(0x02, padded);
}

function derBitString(content: Buffer): Buffer {
  return derTag(0x03, Buffer.concat([Buffer.from([0]), content]));
}

function derUtf8(text: string): Buffer {
  return derTag(0x0c, Buffer.from(text, 'utf8'));
}

function derUtcTime(date: Date): Buffer {
  const yy = String(date.getUTCFullYear() % 100).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mi = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return derTag(0x17, Buffer.from(`${yy}${mm}${dd}${hh}${mi}${ss}Z`, 'ascii'));
}

function createSelfSignedCertPem(options: {
  commonName: string;
  dnsNames?: string[];
  ipAddresses?: string[];
}): { certPem: string; keyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

  const sha256WithRsaAlg = derSeq(
    derOid('1.2.840.113549.1.1.11'),
    derTag(0x05, Buffer.alloc(0)),
  );
  const subjectName = derSeq(
    derSet(derSeq(derOid('2.5.4.3'), derUtf8(options.commonName))),
  );
  const now = new Date();
  const later = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const validity = derSeq(derUtcTime(now), derUtcTime(later));

  const sanEntries: Buffer[] = [];
  for (const dns of options.dnsNames ?? []) {
    sanEntries.push(derTag(0x82, Buffer.from(dns, 'ascii')));
  }
  for (const ip of options.ipAddresses ?? []) {
    const octets = ip.split('.').map(Number);
    sanEntries.push(derTag(0x87, Buffer.from(octets)));
  }

  const extensions = derTag(
    0xa3,
    derSeq(
      derSeq(
        derOid('2.5.29.19'),
        derTag(0x01, Buffer.from([0xff])),
        derTag(0x04, derSeq(derTag(0x01, Buffer.from([0xff])))),
      ),
      derSeq(derOid('2.5.29.17'), derTag(0x04, derSeq(...sanEntries))),
    ),
  );

  const tbsCertificate = derSeq(
    derTag(0xa0, derInt(2)),
    derInt(1),
    sha256WithRsaAlg,
    subjectName,
    validity,
    subjectName,
    spkiDer,
    extensions,
  );

  const signature = sign('sha256', tbsCertificate, privateKey);
  const fullCert = derSeq(
    tbsCertificate,
    sha256WithRsaAlg,
    derBitString(signature),
  );
  const b64 = fullCert.toString('base64').replace(/(.{64})/g, '$1\n');
  const certPem = `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
  return { certPem, keyPem };
}

function httpsGetWithAgent(url: string, agent?: Agent): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method: 'GET', agent }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('G5 HTTPS policy, /api/v1 prefix, TLS verification, and G7 token contract regression', () => {
  it('rejects plain HTTP origins for ventas upstream while preserving HTTPS', () => {
    expect(() =>
      internalOrigin('http://127.0.0.1:4123', false, 'ventas'),
    ).toThrow('INVALID_COMMERCIAL_ORIGIN');
    expect(() =>
      internalOrigin('http://127.0.0.1:4123', true, 'ventas'),
    ).toThrow('INVALID_COMMERCIAL_ORIGIN');
    expect(internalOrigin('https://127.0.0.1:4123', false, 'ventas')).toBe(
      'https://127.0.0.1:4123',
    );
  });

  it('requires api-ventas audience and ventas:pedidos:evidencia-cupon:leer scope for obtenerSnapshotCuponG5', () => {
    expect(internalOperations.obtenerSnapshotCuponG5).toEqual({
      service: 'ventas',
      scope: 'ventas:pedidos:evidencia-cupon:leer',
      missing: '',
      clientId: 'promotions-svc',
      audience: 'api-ventas',
    });
  });

  it('requests G5 snapshot under /api/v1/integraciones/productos/pedidos/:orderId/evidencia-cupon', async () => {
    const requestedUrls: string[] = [];
    const requestedHeaders: Record<string, string>[] = [];
    const originalFetch = globalThis.fetch;

    const orderId = '00000000-0000-4000-8000-000000000100';
    const reservationId = '11111111-1111-4111-8111-111111111111';
    const customerRef = '22222222-2222-4222-8222-222222222222';
    const productId = '33333333-3333-4333-8333-333333333333';
    const effectiveAt = '2026-11-26T00:00:00.000Z';

    const snapshotPayload = {
      order_id: orderId,
      commercial_snapshot_ref: orderId,
      reservation_id: reservationId,
      effective_at: effectiveAt,
      customer_ref: customerRef,
      channel_id: 'MARKETPLACE' as const,
      coupon_code: 'PROMO10',
      lines: [
        {
          sku: 'SKU-001',
          product_id: productId,
          quantity: 1,
          currency: 'PEN',
          regular_price: '100.00',
          offer_price: null,
        },
      ],
    };

    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      requestedUrls.push(String(input));
      requestedHeaders.push(
        Object.fromEntries(new Headers(init?.headers).entries()),
      );
      return new Response(JSON.stringify(snapshotPayload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const reader = new InternalHttpReader({
        origin: 'https://127.0.0.1:4999',
        origins: { ventas: 'https://127.0.0.1:4999' },
        mode: 'AUTHENTICATED',
        getServiceAccessToken: async (req) => {
          expect(req.audience).toBe('api-ventas');
          expect(req.scope).toBe('ventas:pedidos:evidencia-cupon:leer');
          return 'jwt-ventas-token';
        },
      });

      const snapshot = new G5CouponSnapshot(reader, {
        verifyCouponCatalogLines: async () =>
          new Map([
            [
              'SKU-001',
              {
                productId,
                categoryIds: [],
                brandId: null,
                isActive: true,
              },
            ],
          ]),
      });

      const command: CouponCommand = {
        message_id: '44444444-4444-4444-8444-444444444444',
        schema_version: 2,
        operation_id: '55555555-5555-4555-8555-555555555555',
        occurred_at: effectiveAt,
        correlation_id: '66666666-6666-4666-8666-666666666666',
        causation_id: '77777777-7777-4777-8777-777777777777',
        producer: 'modulo-ventas',
        kind: 'command',
        name: consumptionName,
        data: {
          order_id: orderId,
          commercial_snapshot_ref: orderId,
          reservation_id: reservationId,
          effective_at: effectiveAt,
          customer_ref: customerRef,
          channel_id: 'MARKETPLACE',
          coupon_code: 'PROMO10',
        },
      };

      await snapshot.read(command, AbortSignal.timeout(2000));

      expect(requestedUrls).toEqual([
        `https://127.0.0.1:4999/api/v1/integraciones/productos/pedidos/${orderId}/evidencia-cupon`,
      ]);
      expect(requestedHeaders[0]?.authorization).toBe(
        'Bearer jwt-ventas-token',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('verifies TLS certificates: rejects untrusted CA, accepts trusted CA with valid SAN, and rejects wrong SAN identity', async () => {
    const validIdentity = createSelfSignedCertPem({
      commonName: '127.0.0.1',
      dnsNames: ['localhost'],
      ipAddresses: ['127.0.0.1'],
    });
    const wrongIdentity = createSelfSignedCertPem({
      commonName: 'wrong-host.invalid',
      dnsNames: ['wrong-host.invalid'],
    });

    const validServer = createHttpsServer(
      { cert: validIdentity.certPem, key: validIdentity.keyPem },
      (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      },
    );
    validServer.listen(0, '127.0.0.1');
    await once(validServer, 'listening');

    const wrongServer = createHttpsServer(
      { cert: wrongIdentity.certPem, key: wrongIdentity.keyPem },
      (_req, res) => {
        res.writeHead(200);
        res.end('{"ok":true}');
      },
    );
    wrongServer.listen(0, '127.0.0.1');
    await once(wrongServer, 'listening');

    const validAddr = validServer.address();
    const wrongAddr = wrongServer.address();
    if (
      !validAddr ||
      typeof validAddr === 'string' ||
      !wrongAddr ||
      typeof wrongAddr === 'string'
    ) {
      validServer.close();
      wrongServer.close();
      throw new Error('Failed to bind ephemeral HTTPS test servers');
    }

    const validAgent = new Agent({ ca: validIdentity.certPem });
    const untrustedAgent = new Agent();
    const wrongHostAgent = new Agent({ ca: wrongIdentity.certPem });

    try {
      await expect(
        httpsGetWithAgent(
          `https://127.0.0.1:${validAddr.port}/`,
          untrustedAgent,
        ),
      ).rejects.toThrow();

      const status = await httpsGetWithAgent(
        `https://127.0.0.1:${validAddr.port}/`,
        validAgent,
      );
      expect(status).toBe(200);

      await expect(
        httpsGetWithAgent(
          `https://127.0.0.1:${wrongAddr.port}/`,
          wrongHostAgent,
        ),
      ).rejects.toThrow();
    } finally {
      validAgent.destroy();
      untrustedAgent.destroy();
      wrongHostAgent.destroy();
      await Promise.all([
        new Promise((r) => validServer.close(() => r(undefined))),
        new Promise((r) => wrongServer.close(() => r(undefined))),
      ]);
    }
  });
});
