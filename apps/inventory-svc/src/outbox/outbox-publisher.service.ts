import { Injectable, Logger, Inject } from '@nestjs/common';
import amqp from 'amqplib';
import { DatabaseService } from '../database/database.service.js';
import { loadInventoryConfig } from '../config/inventory.config.js';
import { OUTBOX_REPOSITORY } from '../repositories/interfaces/repository.tokens.js';
import type {
  IOutboxRepository,
  OutboxEntity,
} from '../repositories/interfaces/outbox.repository.interface.js';

export interface IMessageBrokerPublisher {
  publish(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options?: amqp.Options.Publish,
  ): Promise<boolean>;
}

@Injectable()
export class OutboxPublisherService {
  private readonly logger = new Logger(OutboxPublisherService.name);
  private customPublisher: IMessageBrokerPublisher | null = null;

  constructor(
    private readonly databaseService: DatabaseService,
    @Inject(OUTBOX_REPOSITORY)
    private readonly outboxRepository: IOutboxRepository,
  ) {}

  setCustomPublisher(publisher: IMessageBrokerPublisher | null): void {
    this.customPublisher = publisher;
  }

  /**
   * Despacha eventos PENDING de inventory.outbox hacia RabbitMQ con publisher confirms,
   * entrega obligatoria (mandatory: true) y detección de basic.return como fallo de enrutamiento.
   * Utiliza FOR UPDATE SKIP LOCKED dentro de una transacción para evitar publicaciones duplicadas
   * entre múltiples instancias o dispatchers concurrentes.
   */
  async dispatchPending(
    limit = 50,
  ): Promise<{ dispatched: number; failed: number; skipped: boolean }> {
    const config = loadInventoryConfig();

    if (!config.rabbitMqUrl && !this.customPublisher) {
      this.logger.debug(
        'RABBITMQ_URL no configurado; los eventos outbox permanecen durables en estado PENDING.',
      );
      return { dispatched: 0, failed: 0, skipped: true };
    }

    let amqpConn: amqp.ChannelModel | null = null;
    let confirmChannel: amqp.ConfirmChannel | null = null;
    const returnedMessageIds = new Set<string>();

    try {
      if (!this.customPublisher && config.rabbitMqUrl) {
        amqpConn = await amqp.connect(config.rabbitMqUrl);
        confirmChannel = await amqpConn.createConfirmChannel();

        // Escuchar devoluciones cuando un mensaje obligatorio no encuentra cola en el exchange
        confirmChannel.on('return', (returnedMsg) => {
          const msgId = returnedMsg.properties.messageId;
          if (msgId) {
            returnedMessageIds.add(msgId);
          }
          this.logger.warn(
            `Mensaje outbox devuelto por el broker (NO ROUTE / basic.return): messageId=${msgId}, routingKey=${returnedMsg.fields.routingKey}`,
          );
        });
      }

      // Reclamación transaccional con FOR UPDATE SKIP LOCKED
      return await this.databaseService.transaction(async (txClient) => {
        let pendingRows: OutboxEntity[] = [];

        try {
          pendingRows =
            await this.outboxRepository.findPendingForUpdateSkipLocked(
              txClient,
              limit,
            );
        } catch (dbErr) {
          this.logger.warn(
            `No fue posible consultar inventory.outbox con FOR UPDATE SKIP LOCKED: ${(dbErr as Error).message}`,
          );
          return { dispatched: 0, failed: 0, skipped: true };
        }

        if (pendingRows.length === 0) {
          return { dispatched: 0, failed: 0, skipped: false };
        }

        let dispatched = 0;
        let failed = 0;

        for (const row of pendingRows) {
          const payload =
            typeof row.payload === 'string'
              ? JSON.parse(row.payload)
              : row.payload;
          const exchange =
            payload.kind === 'result' ? 'po.results.x' : 'po.events.x';
          const routingKey = row.event_type;
          const content = Buffer.from(JSON.stringify(payload));
          // Preservar exactamente el message_id de negocio sin regenerarlo en reintentos
          const messageId = payload.message_id || row.event_id;

          try {
            if (this.customPublisher) {
              const publishedOk = await this.customPublisher.publish(
                exchange,
                routingKey,
                content,
                {
                  messageId,
                  correlationId:
                    payload.correlation_id || row.correlation_id || undefined,
                  contentType: 'application/json',
                  mandatory: true,
                },
              );
              if (!publishedOk) {
                throw new Error(
                  `El publicador devolvió false (no confirmado) para mensaje ${messageId}`,
                );
              }
            } else if (confirmChannel) {
              await new Promise<void>((resolve, reject) => {
                (confirmChannel as amqp.ConfirmChannel).publish(
                  exchange,
                  routingKey,
                  content,
                  {
                    messageId,
                    correlationId:
                      payload.correlation_id || row.correlation_id || undefined,
                    contentType: 'application/json',
                    mandatory: true,
                    persistent: true,
                  },
                  (err) => {
                    if (err) {
                      reject(err);
                    } else if (returnedMessageIds.has(messageId)) {
                      reject(
                        new Error(
                          `Mensaje ${messageId} devuelto por el broker: sin cola enlazada (basic.return)`,
                        ),
                      );
                    } else {
                      resolve();
                    }
                  },
                );
              });
            }

            // Marcar como publicado durablemente tras confirmación exitosa del broker
            await this.outboxRepository.markAsPublished(row.id, txClient);
            dispatched++;
          } catch (pubErr) {
            failed++;
            this.logger.error(
              `Fallo al publicar evento outbox ${row.id} (${row.event_type}): ${(pubErr as Error).message}. Se conserva PENDING.`,
            );
          }
        }

        return { dispatched, failed, skipped: false };
      });
    } catch (connErr) {
      this.logger.warn(
        `Fallo de conexión RabbitMQ en OutboxPublisherService: ${(connErr as Error).message}. Frontera aislada sin afectar la persistencia interna.`,
      );
      return { dispatched: 0, failed: 0, skipped: true };
    } finally {
      if (confirmChannel) {
        try {
          await confirmChannel.close();
        } catch {
          // Ignorar error al cerrar canal
        }
      }
      if (amqpConn) {
        try {
          await amqpConn.close();
        } catch {
          // Ignorar error al cerrar conexión
        }
      }
    }
  }
}
