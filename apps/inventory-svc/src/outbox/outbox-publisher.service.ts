import { Injectable, Logger } from '@nestjs/common';
import amqp from 'amqplib';
import { DatabaseService } from '../database/database.service.js';
import { loadInventoryConfig } from '../config/inventory.config.js';

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

  constructor(private readonly databaseService: DatabaseService) {}

  setCustomPublisher(publisher: IMessageBrokerPublisher | null): void {
    this.customPublisher = publisher;
  }

  /**
   * Dispatches pending events from inventory.outbox to RabbitMQ with publisher confirms.
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
    let pendingRows: Array<{
      id: string;
      event_id: string;
      event_type: string;
      correlation_id: string | null;
      payload: any;
    }> = [];

    try {
      const res = await this.databaseService.query(
        `SELECT id, event_id, event_type, correlation_id, payload 
         FROM inventory.outbox 
         WHERE status = 'PENDING' 
         ORDER BY created_at ASC 
         LIMIT $1`,
        [limit],
      );
      pendingRows = res.rows;
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

    let amqpConn: any = null;
    let confirmChannel: any = null;

    try {
      if (!this.customPublisher) {
        amqpConn = await amqp.connect(config.rabbitMqUrl!);
        confirmChannel = await amqpConn.createConfirmChannel();
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
              mandatory: false,
            });
          } else {
            await new Promise<void>((resolve, reject) => {
              confirmChannel.publish(
                exchange,
                routingKey,
                content,
                {
                  messageId: payload.message_id || row.event_id,
                  correlationId:
                    payload.correlation_id || row.correlation_id || undefined,
                  contentType: 'application/json',
                  mandatory: false,
                },
                (err: any) => {
                  if (err) reject(err);
                  else resolve();
                },
              );
            });
          }

          // Mark as published
          await this.databaseService.query(
            `UPDATE inventory.outbox SET status = 'PUBLISHED', published_at = now() WHERE id = $1`,
            [row.id],
          );
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
        } catch {}
      }
      if (amqpConn) {
        try {
          await amqpConn.close();
        } catch {}
      }
    }

    return { dispatched, failed, skipped: false };
  }
}
