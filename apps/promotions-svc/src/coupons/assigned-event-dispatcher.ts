import { assignedEventContracts } from './event-contract.generated.js';
import type { BrokerDelivery } from './coupon-consumer.js';
import { record, matchesSchema } from './schema-validator.js';
import {
  inPromotionsTransaction,
  type SqlClient,
  type SqlPool,
} from '../infrastructure/persistence/sql-transaction.js';

export interface AssignedEvent {
  message_id: string;
  schema_version: number;
  occurred_at: string;
  correlation_id: string;
  causation_id?: string | null;
  operation_id?: string | null;
  kind: 'event';
  name: string;
  producer: string;
  data: Record<string, unknown>;
}
export interface AssignedEventAdapter {
  // A typed, approved mapping must validate its own GenericData content. Schema
  // acceptance alone says nothing about product/SKU/price/stock field semantics.
  validate(data: Record<string, unknown>): boolean;
  // Local projection changes only; never remote I/O while holding this client.
  apply(client: SqlClient, event: AssignedEvent): Promise<void>;
}
export const ASSIGNED_EVENT_ADAPTERS = Symbol('ASSIGNED_EVENT_ADAPTERS');
export type AssignedEventAdapters = Readonly<
  Partial<Record<string, AssignedEventAdapter>>
>;
export const PROMOTIONS_BROKER_IDENTITY = Symbol('PROMOTIONS_BROKER_IDENTITY');
export interface PromotionsBrokerIdentity {
  assertReady(): Promise<void>;
  actor(delivery: BrokerDelivery): Promise<string>;
}
export const blockedBrokerIdentity: PromotionsBrokerIdentity = {
  assertReady: async () => {
    throw new Error('PROMOTIONS_BROKER_IDENTITY_UNAVAILABLE');
  },
  actor: async () => {
    throw new Error('PROMOTIONS_BROKER_IDENTITY_UNAVAILABLE');
  },
};
const handler = 'promotions-assigned-events-v1';

// Does not declare topology, connect at construction, ACK or enable a consumer.
// A failed/missing mapping never becomes a completed Inbox receipt.
export class PromotionsAssignedEventDispatcher {
  constructor(
    private readonly pool: SqlPool,
    private readonly adapters: AssignedEventAdapters,
  ) {}

  assertReady(): void {
    if (
      Object.keys(assignedEventContracts).some((name) => !this.adapters[name])
    )
      throw new Error('PROMOTIONS_EVENT_ADAPTERS_UNAVAILABLE');
  }

  async process(
    delivery: BrokerDelivery,
    actor: string,
  ): Promise<'processed' | 'replayed'> {
    if (
      delivery.content.length > 65536 ||
      delivery.properties.contentType !== 'application/json'
    )
      throw new Error('INVALID_ASSIGNED_EVENT');
    let body: unknown;
    try {
      body = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(delivery.content),
      );
    } catch {
      throw new Error('INVALID_ASSIGNED_EVENT');
    }
    if (!record(body) || typeof body.name !== 'string')
      throw new Error('INVALID_ASSIGNED_EVENT');
    const contract = assignedEventContracts[body.name];
    if (
      !contract ||
      actor !== contract.producer ||
      !matchesSchema(body, contract.schema) ||
      delivery.fields.exchange !== contract.exchange ||
      delivery.fields.routingKey !== contract.routingKey ||
      (delivery.properties.messageId !== undefined &&
        delivery.properties.messageId !== body.message_id)
    )
      throw new Error('INVALID_ASSIGNED_EVENT');
    const event = body as unknown as AssignedEvent;
    const adapter = this.adapters[event.name];
    if (!adapter) throw new Error('PROMOTIONS_EVENT_ADAPTER_UNAVAILABLE');
    try {
      if (!adapter.validate(event.data)) throw new Error();
    } catch {
      throw new Error('INVALID_ASSIGNED_EVENT_DATA');
    }
    try {
      return await inPromotionsTransaction(this.pool, async (client) => {
        const fresh = await client.query(
          'SELECT promotions.fn_begin_inbox($1::jsonb,$2) AS fresh',
          [JSON.stringify(body), handler],
        );
        if (fresh.rows[0].fresh === false) {
          const previous = await client.query(
            'SELECT completed_at,result FROM promotions.inbox WHERE message_id=$1 AND handler=$2',
            [event.message_id, handler],
          );
          if (
            !previous.rows[0]?.completed_at ||
            !record(previous.rows[0].result) ||
            previous.rows[0].result.handled !== true
          )
            throw new Error('INCOMPLETE_ASSIGNED_EVENT');
          return 'replayed';
        }
        await adapter.apply(client, event);
        await client.query(
          'UPDATE promotions.inbox SET completed_at=clock_timestamp(),result=$3::jsonb WHERE message_id=$1 AND handler=$2',
          [event.message_id, handler, JSON.stringify({ handled: true })],
        );
        return 'processed';
      });
    } catch {
      throw new Error('PROMOTIONS_ASSIGNED_EVENT_FAILED');
    }
  }
}
