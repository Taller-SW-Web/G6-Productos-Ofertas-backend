import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { ConfirmChannel } from 'amqplib';
import {
  ConfirmedCatalogPublisher,
  readCatalogAmqpConfig,
} from './catalog-amqp.js';
import { envelope } from './catalog-messages.js';

describe('Confirmed catalog publisher (transport fixture, not live broker evidence)', () => {
  function fixture(writable = true) {
    const channel = new EventEmitter() as EventEmitter & {
      publish: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    };
    channel.publish = vi.fn(() => writable);
    channel.close = vi.fn(async () => undefined);
    return {
      channel,
      publisher: new ConfirmedCatalogPublisher(
        channel as unknown as ConfirmChannel,
        'catalog-test',
        100,
      ),
    };
  }
  it('waits for publisher confirmation and uses persistent mandatory messages', async () => {
    const { channel, publisher } = fixture();
    const message = envelope(
      'catalog.product.deactivated',
      { product_id: 'p' },
      randomUUID(),
    );
    let done = false;
    const work = publisher.publish(message).then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    const args = channel.publish.mock.calls[0] as unknown as unknown[];
    expect(args[0]).toBe('po.events.x');
    expect(args[1]).toBe(message.name);
    expect(args[3]).toMatchObject({
      persistent: true,
      mandatory: true,
      messageId: message.message_id,
      userId: 'catalog-test',
    });
    (args[4] as (error?: unknown) => void)();
    await work;
    expect(done).toBe(true);
  });
  it('does not mistake basic.return plus a broker ACK for a successful route', async () => {
    const { channel, publisher } = fixture();
    const work = publisher.publish(
      envelope('catalog.product.deactivated', {}, randomUUID()),
    );
    await Promise.resolve();
    channel.emit('return');
    const confirm = (
      channel.publish.mock.calls[0] as unknown as unknown[]
    )[4] as () => void;
    confirm();
    await expect(work).rejects.toThrow('AMQP_PUBLISH_UNCONFIRMED');
  });
  it('honors backpressure and fails unconfirmed publications on channel closure', async () => {
    const { channel, publisher } = fixture(false);
    let done = false;
    const work = publisher
      .publish(envelope('catalog.sku.deactivated', {}, randomUUID()))
      .then(() => {
        done = true;
      });
    await Promise.resolve();
    (
      (channel.publish.mock.calls[0] as unknown as unknown[])[4] as () => void
    )();
    expect(done).toBe(false);
    channel.emit('drain');
    await work;
    expect(done).toBe(true);
    const failed = publisher.publish(
      envelope('catalog.sku.deactivated', {}, randomUUID()),
    );
    await Promise.resolve();
    await Promise.resolve();
    channel.emit('close');
    await expect(failed).rejects.toThrow();
  });
  it('requires explicit authenticated producer mapping and the contractual vhost', () => {
    expect(readCatalogAmqpConfig({})).toBeUndefined();
    expect(() =>
      readCatalogAmqpConfig({ RABBITMQ_URL: 'amqp://user:pass@localhost/' }),
    ).toThrow();
    expect(
      readCatalogAmqpConfig({
        RABBITMQ_URL: 'amqp://catalog:fixture@localhost/g6-productos-ofertas',
        CATALOG_AMQP_PRODUCER_USERS: JSON.stringify({
          'pricing-svc': 'pricing',
          'inventory-svc': 'inventory',
          'taxonomy-svc': 'taxonomy',
          'bulk-svc': 'bulk',
        }),
      }),
    ).toMatchObject({ user: 'catalog' });
  });
});
