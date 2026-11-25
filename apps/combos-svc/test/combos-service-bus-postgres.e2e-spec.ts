import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type {
  ServiceBusReceivedMessage,
  ServiceBusReceiver,
} from '@azure/service-bus';
import request from 'supertest';
import { CombosSvcModule } from '../src/combos-svc.module.js';
import { CombosProblemFilter } from '../src/http/combos-problem.filter.js';
import { combosCorrelationMiddleware } from '../src/http/combos-correlation.middleware.js';
import { CombosDatabase } from '../src/persistence/combos.database.js';
import { CombosEventConsumer } from '../src/messaging/combos-event-consumer.js';
import { CombosSvcService } from '../src/combos-svc.service.js';

const isolatedHarnessEnabled =
  process.env.COMBOS_TEST_EPHEMERAL === '1' &&
  process.env.COMBOS_TEST_DATABASE_URL === 'harness-owned';

function makeSbMessage(
  envelope: Record<string, unknown>,
  overrides: Partial<ServiceBusReceivedMessage> = {},
): ServiceBusReceivedMessage {
  return {
    body: Buffer.from(JSON.stringify(envelope), 'utf8'),
    messageId: String(envelope.message_id),
    correlationId: String(envelope.correlation_id),
    subject: String(envelope.name),
    contentType: 'application/json',
    deliveryCount: 1,
    applicationProperties: {
      producer: envelope.producer as string,
      schema_version: envelope.schema_version as number,
      route_version: 1,
    },
    ...overrides,
  } as unknown as ServiceBusReceivedMessage;
}

function makeFakeReceiver() {
  return {
    completeMessage: vi.fn(async () => undefined),
    abandonMessage: vi.fn(async () => undefined),
    deadLetterMessage: vi.fn(async () => undefined),
  };
}

describe.skipIf(!isolatedHarnessEnabled)(
  'Combos H5 Service Bus R05/R12 PostgreSQL 17 integration (isolated harness)',
  () => {
    let app: INestApplication;
    let database: CombosDatabase;
    let consumer: CombosEventConsumer;
    let service: CombosSvcService;
    let catalog: Server;
    let pricing: Server;
    let identity: Server;
    let issuer: string;
    let catalogOrigin: string;
    let pricingOrigin: string;
    const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const kid = 'combos-h5-sb-pg-key';
    let catalogStatus = 200;
    let catalogDelayMs = 0;
    const skuProductMap = new Map<string, string>();
    const missingSkus = new Set<string>();
    const backup: Record<string, string | undefined> = {};
    const envKeys = [
      'COMBOS_CATALOG_URL',
      'COMBOS_PRICING_URL',
      'COMBOS_CATALOG_CONTEXT_AUTHORIZED',
      'COMBOS_G7_TOKEN_URL',
      'COMBOS_G7_CLIENT_SECRET',
      'COMBOS_AMQP_ENABLED',
      'COMBOS_AMQP_URL',
      'MESSAGING_PROVIDER',
      'COMBOS_SERVICE_BUS_EVENTS_ENABLED',
      'G6_SECURITY_MODE',
      'SECURITY_ISSUER',
      'SECURITY_DISCOVERY_URL',
      'SECURITY_JWKS_URL',
      'COMBOS_ALLOWED_ROLES_LISTAR_COMBOS_ADMIN',
      'COMBOS_ALLOWED_ROLES_CREAR_COMBO',
      'COMBOS_ALLOWED_ROLES_OBTENER_COMBO',
      'COMBOS_ALLOWED_ROLES_ACTUALIZAR_COMBO',
      'COMBOS_ALLOWED_ROLES_DESACTIVAR_COMBO',
      'COMBOS_ALLOWED_ROLES_CONSULTAR_DISPONIBILIDAD_COMBO',
    ];

    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const makeToken = (
      kind: 'acceso' | 'servicio',
      scope?: string,
      overrides: Record<string, unknown> = {},
    ) => {
      const now = Math.floor(Date.now() / 1000);
      const header = encode({ alg: 'RS256', kid });
      const payload = encode({
        iss: issuer,
        aud: ['api-productos'],
        sub:
          kind === 'servicio'
            ? 'modulo-productos'
            : '00000000-0000-4000-8000-000000000010',
        tipo: kind,
        ...(kind === 'acceso' ? { roles: ['GESTOR_COMERCIAL'] } : { scope }),
        iat: now,
        exp: now + 600,
        jti: randomUUID(),
        ...overrides,
      });
      const signature = sign(
        'RSA-SHA256',
        Buffer.from(`${header}.${payload}`),
        keyPair.privateKey,
      ).toString('base64url');
      return `${header}.${payload}.${signature}`;
    };

    beforeAll(async () => {
      for (const key of envKeys) backup[key] = process.env[key];

      catalog = createServer(async (req, res) => {
        if (catalogDelayMs > 0) {
          await new Promise((r) => setTimeout(r, catalogDelayMs));
        }
        if (catalogStatus !== 200) {
          res.writeHead(catalogStatus).end();
          return;
        }
        const match = /^\/api\/v1\/productos\/skus\/([^/]+)\/contexto$/.exec(
          req.url ?? '',
        );
        if (!match) {
          res.writeHead(404).end();
          return;
        }
        const sku = decodeURIComponent(match[1]!);
        if (missingSkus.has(sku)) {
          res
            .writeHead(404, { 'content-type': 'application/problem+json' })
            .end(JSON.stringify({ code: 'SKU_NO_ENCONTRADO' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            sku,
            productId:
              skuProductMap.get(sku) ?? '00000000-0000-4000-8000-000000000099',
            isVariant: false,
            active: true,
            eligible: true,
          }),
        );
      });
      pricing = createServer((req, res) => {
        const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
        const skus = parsed.pathname.includes('/skus/')
          ? [decodeURIComponent(parsed.pathname.split('/').at(-1)!)]
          : (parsed.searchParams.get('skus') ?? '').split(',').filter(Boolean);
        const item = (sku: string) => ({
          sku,
          precio_regular: 25.0,
          precio_oferta: 22.0,
          currency: 'PEN',
          channel_id: null,
          valid_from: '2026-01-01T00:00:00Z',
          valid_until: null,
          price_version: 1,
          vigencia_id: `validity-${sku}`,
          origen: 'PRODUCTO',
        });
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(
            parsed.pathname.includes('/skus/')
              ? JSON.stringify(item(skus[0]!))
              : JSON.stringify({ items: skus.map(item) }),
          );
      });
      identity = createServer((req, res) => {
        if (req.url === '/.well-known/openid-configuration') {
          res.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              issuer,
              jwks_uri: `${issuer}/jwks`,
              token_endpoint: `${issuer}/oauth/token`,
            }),
          );
          return;
        }
        if (req.url === '/jwks') {
          const jwk = keyPair.publicKey.export({ format: 'jwk' });
          res
            .writeHead(200, { 'content-type': 'application/json' })
            .end(
              JSON.stringify({
                keys: [{ ...jwk, kid, use: 'sig', alg: 'RS256' }],
              }),
            );
          return;
        }
        if (req.url === '/oauth/token' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          req.on('data', (c) => chunks.push(c));
          req.on('end', () => {
            const form = new URLSearchParams(
              Buffer.concat(chunks).toString('utf8'),
            );
            if (
              form.get('grant_type') !== 'client_credentials' ||
              form.get('client_id') !== 'modulo-productos' ||
              form.get('client_secret') !== 'test-secret'
            ) {
              res
                .writeHead(401, { 'content-type': 'application/json' })
                .end('{}');
              return;
            }
            const scope = form.get('scope') ?? 'catalogo:leer';
            res.writeHead(200, { 'content-type': 'application/json' }).end(
              JSON.stringify({
                accessToken: makeToken('servicio', scope),
                tokenType: 'Bearer',
                expiresIn: 600,
                scopes: [scope],
              }),
            );
          });
          return;
        }
        res.writeHead(404).end();
      });

      await Promise.all([
        once(catalog.listen(0, '127.0.0.1'), 'listening'),
        once(pricing.listen(0, '127.0.0.1'), 'listening'),
        once(identity.listen(0, '127.0.0.1'), 'listening'),
      ]);
      catalogOrigin = `http://127.0.0.1:${(catalog.address() as AddressInfo).port}`;
      pricingOrigin = `http://127.0.0.1:${(pricing.address() as AddressInfo).port}`;
      issuer = `http://127.0.0.1:${(identity.address() as AddressInfo).port}`;

      process.env.COMBOS_CATALOG_URL = catalogOrigin;
      process.env.COMBOS_PRICING_URL = pricingOrigin;
      process.env.COMBOS_CATALOG_CONTEXT_AUTHORIZED = 'true';
      process.env.COMBOS_G7_TOKEN_URL = `${issuer}/oauth/token`;
      process.env.COMBOS_G7_CLIENT_SECRET = 'test-secret';
      process.env.MESSAGING_PROVIDER = 'AZURE_SERVICE_BUS';
      process.env.COMBOS_SERVICE_BUS_EVENTS_ENABLED = 'false';
      process.env.COMBOS_AMQP_ENABLED = 'false';
      delete process.env.COMBOS_AMQP_URL;
      process.env.G6_SECURITY_MODE = 'G7_AUTHENTICATED';
      process.env.SECURITY_ISSUER = issuer;
      process.env.SECURITY_DISCOVERY_URL = `${issuer}/.well-known/openid-configuration`;
      process.env.SECURITY_JWKS_URL = `${issuer}/jwks`;
      for (const roleKey of [
        'COMBOS_ALLOWED_ROLES_LISTAR_COMBOS_ADMIN',
        'COMBOS_ALLOWED_ROLES_CREAR_COMBO',
        'COMBOS_ALLOWED_ROLES_OBTENER_COMBO',
        'COMBOS_ALLOWED_ROLES_ACTUALIZAR_COMBO',
        'COMBOS_ALLOWED_ROLES_DESACTIVAR_COMBO',
        'COMBOS_ALLOWED_ROLES_CONSULTAR_DISPONIBILIDAD_COMBO',
      ]) {
        process.env[roleKey] = 'GESTOR_COMERCIAL';
      }

      const mod = await Test.createTestingModule({
        imports: [CombosSvcModule],
      }).compile();
      app = mod.createNestApplication();
      app.setGlobalPrefix('api/v1', { exclude: ['health', 'ready'] });
      app.use(combosCorrelationMiddleware);
      app.useGlobalFilters(new CombosProblemFilter());
      await app.init();

      database = app.get(CombosDatabase);
      consumer = app.get(CombosEventConsumer);
      service = app.get(CombosSvcService);
    });

    afterAll(async () => {
      await app?.close();
      catalog?.close();
      pricing?.close();
      identity?.close();
      for (const key of envKeys) {
        if (backup[key] === undefined) delete process.env[key];
        else process.env[key] = backup[key];
      }
    });

    async function createCombo(skus: [string, string]) {
      const response = await request(app.getHttpServer())
        .post('/api/v1/combos')
        .set('authorization', `Bearer ${makeToken('acceso')}`)
        .send({
          nombre: `Combo ${skus[0]}`,
          descripcion: 'H5 Service Bus test combo',
          componentes: [
            { sku: skus[0], cantidad: 1 },
            { sku: skus[1], cantidad: 1 },
          ],
          precioCombo: 35,
        })
        .expect(201);
      return String(response.body.combo_id);
    }

    it('T08 + T12: enforces 401/403 HTTP auth, runs under non-owner runtime role, and reports readiness permissions', async () => {
      await request(app.getHttpServer()).get('/api/v1/combos').expect(401);
      await request(app.getHttpServer())
        .get('/api/v1/combos')
        .set(
          'authorization',
          `Bearer ${makeToken('acceso', undefined, { roles: ['OTRO_ROL'] })}`,
        )
        .expect(403);

      const roleCheck = await database.query((c) =>
        c.query<{ current_user: string; is_super: boolean }>(
          'SELECT current_user, usesuper AS is_super FROM pg_user WHERE usename = current_user',
        ),
      );
      if (process.env.COMBOS_TEST_EXPECT_RUNTIME_ROLE === '1') {
        expect(roleCheck.rows[0]?.current_user).toBe('po_combos_app');
        expect(roleCheck.rows[0]?.is_super).toBe(false);
      }
      const readiness = await service.readiness(consumer.readinessDetails());
      expect(readiness).toMatchObject({
        status: 'ok',
        transport: 'AZURE_SERVICE_BUS',
        dependencies: {
          postgres: 'ok',
          postgres_permissions: 'ok',
        },
      });

      if (
        process.env.COMBOS_TEST_READONLY_PGUSER &&
        process.env.COMBOS_TEST_READONLY_PGPASSWORD
      ) {
        const prevUser = process.env.PGUSER;
        const prevPass = process.env.PGPASSWORD;
        process.env.PGUSER = process.env.COMBOS_TEST_READONLY_PGUSER;
        process.env.PGPASSWORD = process.env.COMBOS_TEST_READONLY_PGPASSWORD;
        const readonlyDb = new CombosDatabase();
        try {
          const readonlyDetails = await readonlyDb.readyDetailed();
          expect(readonlyDetails).toEqual({
            available: true,
            permissionsOk: false,
          });
          expect(await readonlyDb.ready()).toBe(false);
        } finally {
          await readonlyDb.onModuleDestroy().catch(() => undefined);
          process.env.PGUSER = prevUser;
          process.env.PGPASSWORD = prevPass;
        }
      }
    });

    it('T01 + T05 + T09: deactivates SKU, preserves other component, blocks Inventory reactivation, and preserves conservative HTTP availability', async () => {
      const skuA = `H5-T01-A-${randomUUID().slice(0, 8)}`;
      const skuB = `H5-T01-B-${randomUUID().slice(0, 8)}`;
      const comboId = await createCombo([skuA, skuB]);
      const receiver = makeFakeReceiver();

      const skuDeactivated = makeSbMessage({
        message_id: `r05-sku-${randomUUID()}`,
        schema_version: 1,
        occurred_at: '2026-11-25T10:00:00Z',
        correlation_id: 'corr-t01',
        causation_id: null,
        operation_id: randomUUID(),
        producer: 'catalog-svc',
        kind: 'event',
        name: 'catalog.sku.deactivated',
        data: {
          sku: skuA,
          product_id: 'PROD-A',
          sku_version: 1,
          changed_at: '2026-11-25T10:00:00Z',
        },
      });
      await consumer.processServiceBusDelivery(
        'g6.combos.from.catalog',
        receiver as unknown as ServiceBusReceiver,
        skuDeactivated,
      );
      expect(receiver.completeMessage).toHaveBeenCalledTimes(1);

      // T05: positive stock change from Inventory must NOT reactivate skuA
      const stockPositive = makeSbMessage({
        message_id: `r12-stock-${randomUUID()}`,
        schema_version: 2,
        occurred_at: '2026-11-25T10:05:00Z',
        correlation_id: 'corr-t05',
        producer: 'inventory-svc',
        kind: 'event',
        name: 'inventory.stock.changed',
        data: {
          sku: skuA,
          location_id: randomUUID(),
          on_hand: 25,
          reserved: 0,
          blocked: 0,
          available: 25,
          estado: 'DISPONIBLE',
          stock_version: 1,
          updated_at: '2026-11-25T10:05:00Z',
        },
      });
      await consumer.processServiceBusDelivery(
        'g6.combos.from.inventory',
        receiver as unknown as ServiceBusReceiver,
        stockPositive,
      );
      expect(receiver.completeMessage).toHaveBeenCalledTimes(2);

      const eligibility = await service.evaluateEligibility(comboId);
      expect(eligibility.commercialEligibility).toBe('INELEGIBLE');
      expect(eligibility.components).toEqual(
        expect.arrayContaining([
          { sku: skuA, status: 'INACTIVO' },
          { sku: skuB, status: 'ACTIVO' },
        ]),
      );

      // T09: HTTP availability remains conservative
      const avail = await request(app.getHttpServer())
        .get(`/api/v1/combos/${comboId}/disponibilidad`)
        .set('authorization', `Bearer ${makeToken('acceso')}`)
        .expect(200);
      expect(avail.body).toMatchObject({
        comboId,
        verificable: false,
        cantidadInformativa: null,
        estadoActualizacion: 'INCOMPLETA',
      });
    });

    it('T02 + T03: resolves multiple SKUs for product deactivation and fails conservatively on Catalog 503 or 404', async () => {
      const prodId = randomUUID();
      const sku1 = `H5-T02-1-${randomUUID().slice(0, 8)}`;
      const sku2 = `H5-T02-2-${randomUUID().slice(0, 8)}`;
      const skuOther = `H5-T02-O-${randomUUID().slice(0, 8)}`;
      skuProductMap.set(sku1, prodId);
      skuProductMap.set(sku2, prodId);
      const comboId = await createCombo([sku1, skuOther]);
      const combo2Id = await createCombo([sku2, skuOther]);
      const receiver = makeFakeReceiver();

      const msgId = `r05-prod-${randomUUID()}`;
      const prodMsg = makeSbMessage({
        message_id: msgId,
        schema_version: 1,
        occurred_at: '2026-11-25T10:10:00Z',
        correlation_id: 'opaque-corr-t02',
        producer: 'catalog-svc',
        kind: 'event',
        name: 'catalog.product.deactivated',
        data: {
          product_id: prodId,
          product_version: 1,
          changed_at: '2026-11-25T10:10:00Z',
        },
      });

      // T03: Catalog 503 must abandon and NOT insert Inbox
      catalogStatus = 503;
      await consumer.processServiceBusDelivery(
        'g6.combos.from.catalog',
        receiver as unknown as ServiceBusReceiver,
        prodMsg,
      );
      expect(receiver.abandonMessage).toHaveBeenCalledTimes(1);
      const inboxAfter503 = await database.query((c) =>
        c.query('SELECT 1 FROM combos.inbox WHERE message_id = $1', [msgId]),
      );
      expect(inboxAfter503.rowCount).toBe(0);

      // T03: Catalog 404 SKU_NO_ENCONTRADO must abandon and NOT insert Inbox
      catalogStatus = 200;
      missingSkus.add(sku1);
      await consumer.processServiceBusDelivery(
        'g6.combos.from.catalog',
        receiver as unknown as ServiceBusReceiver,
        prodMsg,
      );
      expect(receiver.abandonMessage).toHaveBeenCalledTimes(2);
      const inboxAfter404 = await database.query((c) =>
        c.query('SELECT 1 FROM combos.inbox WHERE message_id = $1', [msgId]),
      );
      expect(inboxAfter404.rowCount).toBe(0);

      // T02: Recovery succeeds and deactivates both sku1 and sku2
      missingSkus.delete(sku1);
      await consumer.processServiceBusDelivery(
        'g6.combos.from.catalog',
        receiver as unknown as ServiceBusReceiver,
        prodMsg,
      );
      expect(receiver.completeMessage).toHaveBeenCalledTimes(1);
      expect(
        (await service.evaluateEligibility(comboId)).commercialEligibility,
      ).toBe('INELEGIBLE');
      expect(
        (await service.evaluateEligibility(combo2Id)).commercialEligibility,
      ).toBe('INELEGIBLE');
    });

    it('T04 + T06 + T07: handles multi-location out-of-order R12, Inbox duplicates/conflicts, and ACK loss after commit', async () => {
      const sku = `H5-T04-${randomUUID().slice(0, 8)}`;
      const skuOther = `H5-T04-O-${randomUUID().slice(0, 8)}`;
      const comboId = await createCombo([sku, skuOther]);
      const receiver = makeFakeReceiver();

      // Newer event arrives first, older location event arrives second -> projected_available remains NULL and observed_at does not regress
      const newer = makeSbMessage({
        message_id: `r12-new-${randomUUID()}`,
        schema_version: 2,
        occurred_at: '2026-11-25T11:00:00Z',
        correlation_id: 'corr-new',
        producer: 'inventory-svc',
        kind: 'event',
        name: 'inventory.stock.changed',
        data: {
          sku,
          location_id: randomUUID(),
          on_hand: 3,
          reserved: 0,
          blocked: 0,
          available: 3,
          estado: 'STOCK_BAJO',
          stock_version: 5,
          updated_at: '2026-11-25T11:00:00Z',
        },
      });
      const olderOtherLocation = makeSbMessage({
        message_id: `r12-old-${randomUUID()}`,
        schema_version: 2,
        occurred_at: '2026-11-25T09:00:00Z',
        correlation_id: 'corr-old',
        producer: 'inventory-svc',
        kind: 'event',
        name: 'inventory.stock.changed',
        data: {
          sku,
          location_id: randomUUID(),
          on_hand: 50,
          reserved: 0,
          blocked: 0,
          available: 50,
          estado: 'DISPONIBLE',
          stock_version: 1,
          updated_at: '2026-11-25T09:00:00Z',
        },
      });
      await consumer.processServiceBusDelivery(
        'g6.combos.from.inventory',
        receiver as unknown as ServiceBusReceiver,
        newer,
      );
      await consumer.processServiceBusDelivery(
        'g6.combos.from.inventory',
        receiver as unknown as ServiceBusReceiver,
        olderOtherLocation,
      );
      const projections = await service.componentProjections(comboId);
      const itemProj = projections.find((p) => p.sku === sku)!;
      expect(itemProj.projectedAvailable).toBeNull();
      expect(itemProj.inventoryObservedAt?.toISOString()).toBe(
        '2026-11-25T11:00:00.000Z',
      );

      // T07: ACK lost after commit -> redelivery hits DUPLICATE and completes
      const ackLostMsgId = `r12-ack-${randomUUID()}`;
      const ackLostMsg = makeSbMessage({
        message_id: ackLostMsgId,
        schema_version: 2,
        occurred_at: '2026-11-25T11:05:00Z',
        correlation_id: 'corr-ack',
        producer: 'inventory-svc',
        kind: 'event',
        name: 'inventory.stock.changed',
        data: {
          sku,
          location_id: randomUUID(),
          on_hand: 10,
          reserved: 0,
          blocked: 0,
          available: 10,
          estado: 'DISPONIBLE',
          stock_version: 2,
          updated_at: '2026-11-25T11:05:00Z',
        },
      });
      receiver.completeMessage.mockRejectedValueOnce(new Error('ACK_LOST'));
      await expect(
        consumer.processServiceBusDelivery(
          'g6.combos.from.inventory',
          receiver as unknown as ServiceBusReceiver,
          ackLostMsg,
        ),
      ).rejects.toThrow('ACK_LOST');

      // Redelivery succeeds
      await consumer.processServiceBusDelivery(
        'g6.combos.from.inventory',
        receiver as unknown as ServiceBusReceiver,
        ackLostMsg,
      );

      // T06: Same messageId with different payload -> deadLetterMessage COMBOS_MESSAGE_ID_CONFLICT
      const conflictMsg = makeSbMessage({
        message_id: ackLostMsgId,
        schema_version: 2,
        occurred_at: '2026-11-25T11:06:00Z',
        correlation_id: 'corr-ack',
        producer: 'inventory-svc',
        kind: 'event',
        name: 'inventory.stock.changed',
        data: {
          sku,
          location_id: randomUUID(),
          on_hand: 99,
          reserved: 0,
          blocked: 0,
          available: 99,
          estado: 'DISPONIBLE',
          stock_version: 3,
          updated_at: '2026-11-25T11:06:00Z',
        },
      });
      await consumer.processServiceBusDelivery(
        'g6.combos.from.inventory',
        receiver as unknown as ServiceBusReceiver,
        conflictMsg,
      );
      expect(receiver.deadLetterMessage).toHaveBeenCalledWith(
        conflictMsg,
        expect.objectContaining({
          deadLetterReason: 'COMBOS_MESSAGE_ID_CONFLICT',
        }),
      );
    });
  },
);
