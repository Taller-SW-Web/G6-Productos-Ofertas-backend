import type {
  MessageHandlers,
  ServiceBusReceivedMessage,
  ServiceBusReceiver,
} from '@azure/service-bus';
import type { ServiceBusClientLike } from './combos-service-bus.js';

/** HTTP in-memory lab adapter. It exercises the real consumer and SQL logic;
 * it does not certify Azure transport, RBAC, lock expiry or persistence. */
export function createIsolatedCombosBusClient(
  origin: string,
): ServiceBusClientLike {
  if (process.env.NODE_ENV !== 'test')
    throw new Error('COMBOS_ISOLATED_BUS_TEST_ONLY');
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
    throw new Error('COMBOS_ISOLATED_BUS_TEST_ONLY');
  const receivers = new Set<ServiceBusReceiver>();
  return {
    createReceiver(queue) {
      let closed = false;
      let timer: ReturnType<typeof setInterval> | undefined;
      let pending: Promise<void> | undefined;
      const call = async (action: string, method: string, body?: unknown) => {
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
          throw new Error(`COMBOS_ISOLATED_BUS_HTTP_${response.status}`);
        return response;
      };
      const settle = async (
        action: string,
        message: ServiceBusReceivedMessage,
        options?: unknown,
      ) => {
        const id = (
          message as ServiceBusReceivedMessage & { _deliveryId: string }
        )._deliveryId;
        if (!id) throw new Error('COMBOS_ISOLATED_DELIVERY_ID_REQUIRED');
        await call(`${action}/${encodeURIComponent(id)}`, 'POST', options);
      };
      const stop = async () => {
        clearInterval(timer);
        timer = undefined;
        await pending;
      };
      const receiver = {
        get isClosed() {
          return closed;
        },
        async peekMessages() {
          return (await (
            await call('peek', 'GET')
          ).json()) as ServiceBusReceivedMessage[];
        },
        subscribe(handlers: MessageHandlers) {
          const receive = async () => {
            try {
              const response = await call('receive', 'POST');
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
        completeMessage: (message: ServiceBusReceivedMessage) =>
          settle('complete', message),
        abandonMessage: (message: ServiceBusReceivedMessage) =>
          settle('abandon', message),
        deadLetterMessage: (
          message: ServiceBusReceivedMessage,
          options?: unknown,
        ) => settle('deadletter', message, options),
        async close() {
          closed = true;
          await stop();
          receivers.delete(receiver as unknown as ServiceBusReceiver);
        },
      } as unknown as ServiceBusReceiver;
      receivers.add(receiver);
      return receiver;
    },
    async close() {
      await Promise.all([...receivers].map((receiver) => receiver.close()));
    },
  };
}
