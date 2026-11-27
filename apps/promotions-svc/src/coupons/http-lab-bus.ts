import type {
  ServiceBusReceivedMessage,
  ServiceBusSender,
} from '@azure/service-bus';
import type { EventReceiver } from './service-bus-events.js';

/** Explicit test-only HTTP in-memory broker; no Azure transport/RBAC claim. */
export function createHttpPromotionsLabBus(origin: string) {
  if (process.env.NODE_ENV !== 'test')
    throw new Error('PROMOTIONS_LAB_BUS_TEST_ONLY');
  const url = new URL(origin);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('PROMOTIONS_LAB_BUS_TEST_ONLY');
  const receivers = new Set<EventReceiver>();
  const request = async (
    queue: string,
    action: string,
    method: string,
    body?: unknown,
  ) => {
    const response = await fetch(
      `${url.origin}/queues/${encodeURIComponent(queue)}/${action}`,
      {
        method,
        signal: AbortSignal.timeout(5000),
        ...(body === undefined
          ? {}
          : {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }),
      },
    );
    if (!response.ok)
      throw new Error(`PROMOTIONS_LAB_BUS_HTTP_${response.status}`);
    return response;
  };
  return {
    sender(
      queue: string,
    ): Pick<ServiceBusSender, 'createMessageBatch' | 'sendMessages' | 'close'> {
      return {
        async createMessageBatch() {
          const messages: Record<string, unknown>[] = [];
          return {
            tryAddMessage(message: Record<string, unknown>) {
              const body =
                message.body instanceof Uint8Array
                  ? Buffer.from(message.body).toString('utf8')
                  : JSON.stringify(message.body);
              messages.push({ ...message, body });
              return true;
            },
            _messages: messages,
          } as never;
        },
        async sendMessages(batch: unknown) {
          const messages = (batch as { _messages: Record<string, unknown>[] })
            ._messages;
          for (const message of messages)
            await request(queue, 'messages', 'POST', message);
        },
        async close() {},
      };
    },
    receiver(queue: string): EventReceiver {
      let timer: ReturnType<typeof setInterval> | undefined;
      let pending: Promise<void> | undefined;
      let closed = false;
      const stop = async () => {
        clearInterval(timer);
        timer = undefined;
        await pending;
      };
      const settle = async (
        action: string,
        message: ServiceBusReceivedMessage,
        options?: unknown,
      ) => {
        const id = (
          message as ServiceBusReceivedMessage & { _deliveryId: string }
        )._deliveryId;
        if (!id) throw new Error('PROMOTIONS_LAB_DELIVERY_ID_REQUIRED');
        await request(
          queue,
          `${action}/${encodeURIComponent(id)}`,
          'POST',
          options,
        );
      };
      const receiver: EventReceiver = {
        async peekMessages() {
          return (await (
            await request(queue, 'peek', 'GET')
          ).json()) as ServiceBusReceivedMessage[];
        },
        subscribe(handlers) {
          const receive = async () => {
            try {
              const response = await request(queue, 'receive', 'POST');
              if (response.status === 204) return;
              const data = (await response.json()) as Record<string, unknown>;
              await handlers.processMessage({
                ...data,
                body: Buffer.from(String(data.body), 'utf8'),
                _deliveryId: data.deliveryId,
              } as unknown as ServiceBusReceivedMessage);
            } catch (error) {
              await handlers.processError({
                error:
                  error instanceof Error ? error : new Error(String(error)),
                errorSource: 'receive',
                entityPath: queue,
                fullyQualifiedNamespace: 'isolated-http-lab',
                identifier: `isolated-${queue}`,
              });
            }
          };
          timer = setInterval(() => {
            if (!closed && !pending)
              pending = receive().finally(() => {
                pending = undefined;
              });
          }, 250);
          timer.unref();
          return { close: stop };
        },
        completeMessage: (message) => settle('complete', message),
        abandonMessage: (message) => settle('abandon', message),
        deadLetterMessage: (message, options) =>
          settle('deadletter', message, options),
        async close() {
          closed = true;
          await stop();
          receivers.delete(receiver);
        },
      };
      receivers.add(receiver);
      return receiver;
    },
    async close() {
      await Promise.all([...receivers].map((receiver) => receiver.close()));
    },
  };
}
