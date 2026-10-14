import { Injectable, Logger } from '@nestjs/common';
import amqp from 'amqplib';
import { DatabaseService } from '../database/database.service.js';
import { loadInventoryConfig } from '../config/inventory.config.js';
import { DrizzleOutboxRepository } from '../repositories/drizzle/drizzle-outbox.repository.js';
import { OutboxEntity } from '../repositories/interfaces/outbox.repository.interface.js';

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
    private readonly outboxRepository: DrizzleOutboxRepository,
  ) {}

  setCustomPublisher(publisher: IMessageBrokerPublisher | null): void {
    this.customPublisher = publisher;
  }

  /**
   * Dispatches pending events from inventory.outbox to RabbitMQ with publisher confirms and mandatory delivery.
   * If RabbitMQ is not configured or unavailable, it isolates the failure and keeps records PENDING.
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

    // Fetch pending outbox records
    let pendingRows: OutboxEntity[] = [];

    try {
      pendingRows = await this.outboxRepository.findPending(limit);
    } catch (dbErr) {
      this.logger.warn(
        `No fue posible consultar inventory.outbox: ${(dbErr as Error).message}`,
      );
      return { dispatched: 0, failed: 0, skipped: true };
    }

    if (pendingRows.length === 0) {
      return { dispatched: 0, failed: 0, skipped: false };
    }

    let dispatched = 0;
    let failed = 0;

    let amqpConn: amqp.ChannelModel | null = null;
    let confirmChannel: amqp.ConfirmChannel | null = null;

    try {
      if (!this.customPublisher) {
        amqpConn = await amqp.connect(config.rabbitMqUrl!);
        confirmChannel = await amqpConn.createConfirmChannel();

        // Escuchar devoluciones cuando un mensaje obligatorio no encuentra cola en el exchange
        confirmChannel.on('return', (returnedMsg) => {
          this.logger.warn(
            `Mensaje outbox devuelto por el broker (NO ROUTE): routingKey=${returnedMsg.fields.routingKey}`,
          );
        });
      }

      for (const row of pendingRows) {
        const payload =
          typeof row.payload === 'string'
            ? JSON.parse(row.payload)
            : row.payload;
        const exchange =
          payload.kind === 'result' ? 'po.results.x' : 'po.events.x';
        const routingKey = row.event_type;
        const content = Buffer.from(JSON.stringify(payload));

        try {
          if (this.customPublisher) {
            await this.customPublisher.publish(exchange, routingKey, content, {
              messageId: payload.message_id || row.event_id,
              correlationId:
                payload.correlation_id || row.correlation_id || undefined,
              contentType: 'application/json',
              mandatory: true,
            });
          } else if (confirmChannel) {
            await new Promise<void>((resolve, reject) => {
              (confirmChannel as amqp.ConfirmChannel).publish(
                exchange,
                routingKey,
                content,
                {
                  messageId: payload.message_id || row.event_id,
                  correlationId:
                    payload.correlation_id || row.correlation_id || undefined,
                  contentType: 'application/json',
                  mandatory: true,
                  persistent: true,
                },
                (err) => {
                  if (err) reject(err);
                  else resolve();
                },
              );
            });
          }

          // Marcar como publicado durablemente tras confirmación del broker
          await this.outboxRepository.markAsPublished(row.id);
          dispatched++;
        } catch (pubErr) {
          failed++;
          this.logger.error(
            `Fallo al publicar evento outbox ${row.id} (${row.event_type}): ${(pubErr as Error).message}`,
          );
        }
      }
    } catch (connErr) {
      this.logger.warn(
        `Fallo de conexión RabbitMQ en OutboxPublisherService: ${(connErr as Error).message}. Frontera aislada sin afectar la persistencia interna.`,
      );
      return { dispatched, failed: pendingRows.length, skipped: true };
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

    return { dispatched, failed, skipped: false };
  }
}
