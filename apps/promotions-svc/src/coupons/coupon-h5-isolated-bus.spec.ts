import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { isolatedCouponH5Bus } from './coupon-h5-runtime.js';
import { readPromotionsServiceBus } from './service-bus-config.js';

describe('N01 isolatedCouponH5Bus & isolated config (ESCRITA_NO_EJECUTADA)', () => {
  it.each([
    'http://remote.example.test',
    'https://127.0.0.1',
    'http://u:p@127.0.0.1',
    'http://127.0.0.1/path',
  ])('rechaza broker HTTP no aislado %s', (origin) => {
    expect(() =>
      readPromotionsServiceBus({
        NODE_ENV: 'test',
        MESSAGING_PROVIDER: 'AZURE_SERVICE_BUS',
        G6_SECURITY_MODE: 'G7_AUTHENTICATED',
        AUTH_ISSUER: 'http://127.0.0.1:4100',
        AUTH_JWKS_URL: 'http://127.0.0.1:4100/jwks',
        PROMOTIONS_H5_ISOLATED_BUS: '1',
        G6_ISOLATED_SERVICE_BUS_URL: origin,
      }),
    ).toThrow('PROMOTIONS_SERVICE_BUS_CONFIGURATION_INVALID');
  });

  it('conecta el broker HTTP común solo con aislamiento explícito de test', () => {
    const env = {
      NODE_ENV: 'test',
      MESSAGING_PROVIDER: 'AZURE_SERVICE_BUS',
      G6_SECURITY_MODE: 'G7_AUTHENTICATED',
      AUTH_ISSUER: 'http://127.0.0.1:4100',
      AUTH_JWKS_URL: 'http://127.0.0.1:4100/jwks',
      PROMOTIONS_H5_ISOLATED_BUS: '1',
      G6_ISOLATED_SERVICE_BUS_URL: 'http://127.0.0.1:4200',
    };
    expect(readPromotionsServiceBus(env)).toMatchObject({
      isolatedBusUrl: env.G6_ISOLATED_SERVICE_BUS_URL,
    });
    expect(() =>
      readPromotionsServiceBus({ ...env, NODE_ENV: 'production' }),
    ).toThrow();
    expect(() =>
      readPromotionsServiceBus({
        ...env,
        PROMOTIONS_H5_ISOLATED_BUS: undefined,
      }),
    ).toThrow();
  });

  it('acepta PROMOTIONS_H5_ISOLATED_BUS=1 solo en NODE_ENV=test sin RABBITMQ_URL ni AZURE_CLIENT_ID', () => {
    const cfg = readPromotionsServiceBus({
      NODE_ENV: 'test',
      MESSAGING_PROVIDER: 'AZURE_SERVICE_BUS',
      G6_SECURITY_MODE: 'G7_AUTHENTICATED',
      AUTH_ISSUER: 'http://127.0.0.1:4100',
      AUTH_JWKS_URL: 'http://127.0.0.1:4100/jwks',
      PROMOTIONS_H5_COUPON_COMMANDS_ENABLED: 'true',
      PROMOTIONS_H5_ISOLATED_BUS: '1',
    });
    expect(cfg?.isolatedBus).toBe(true);
    expect(cfg?.couponCommandsEnabled).toBe(true);

    expect(() =>
      readPromotionsServiceBus({
        NODE_ENV: 'production',
        MESSAGING_PROVIDER: 'AZURE_SERVICE_BUS',
        G6_SECURITY_MODE: 'G7_AUTHENTICATED',
        AUTH_ISSUER: 'https://g7.example.com',
        AUTH_JWKS_URL: 'https://g7.example.com/jwks',
        PROMOTIONS_H5_COUPON_COMMANDS_ENABLED: 'true',
        PROMOTIONS_H5_ISOLATED_BUS: '1',
      }),
    ).toThrow('PROMOTIONS_SERVICE_BUS_CONFIGURATION_INVALID');
  });

  it('retiene mensajes en cola hasta subscribe(), registra settlement y rechaza envío tras close()', async () => {
    const bus = isolatedCouponH5Bus();
    const messageId = randomUUID();
    const batch = await bus.sender.createMessageBatch();
    expect(batch.tryAddMessage({ messageId, body: { ok: true } })).toBe(true);

    await bus.sender.sendMessages(batch);
    expect(bus.pendingQueue).toHaveLength(1);

    const processed: string[] = [];
    bus.receiver.subscribe(
      {
        processMessage: async (msg) => {
          processed.push(String(msg.messageId));
          await bus.receiver.completeMessage(msg);
        },
        processError: vi.fn(),
      },
      { autoCompleteMessages: false },
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(processed).toEqual([messageId]);
    expect(bus.settled.completed).toEqual([messageId]);

    await bus.receiver.abandonMessage({ messageId } as never);
    await bus.receiver.deadLetterMessage({ messageId } as never, {
      deadLetterReason: 'INVALID_ENVELOPE',
    });
    expect(bus.settled.abandoned).toEqual([messageId]);
    expect(bus.settled.deadLettered).toEqual([
      { messageId, reason: 'INVALID_ENVELOPE' },
    ]);

    await bus.close();
    await expect(bus.sender.sendMessages(batch)).rejects.toThrow(
      'ISOLATED_COUPON_BUS_CLOSED',
    );
  });
});
