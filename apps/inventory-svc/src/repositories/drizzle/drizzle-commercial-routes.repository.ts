import { Injectable } from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service.js';
import { IDatabaseClient } from '../../database/database.interface.js';
import * as schema from '../../drizzle/schema.js';
import { ICommercialRoutesRepository } from '../interfaces/commercial-routes.repository.interface.js';

@Injectable()
export class DrizzleCommercialRoutesRepository implements ICommercialRoutesRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async findActiveByChannelAndFulfillment(
    channelId: string,
    mode: string,
    fulfillmentRef: string,
    client?: IDatabaseClient,
  ): Promise<string | null> {
    const db = client?.drizzle ?? this.databaseService.getDrizzle();
    if (db) {
      const rows = await db
        .select({
          location_id: schema.commercialFulfillmentRoutes.location_id,
        })
        .from(schema.commercialFulfillmentRoutes)
        .where(
          and(
            eq(schema.commercialFulfillmentRoutes.channel_id, channelId),
            eq(schema.commercialFulfillmentRoutes.mode, mode),
            eq(
              schema.commercialFulfillmentRoutes.fulfillment_ref,
              fulfillmentRef,
            ),
            eq(schema.commercialFulfillmentRoutes.active, true),
          ),
        );

      if (rows.length === 1) {
        return rows[0].location_id;
      }
      return null;
    }

    const sql = `
      SELECT location_id FROM inventory.commercial_fulfillment_routes
      WHERE channel_id = $1 AND mode = $2 AND fulfillment_ref = $3 AND active = true
    `;
    const res = client
      ? await client.query(sql, [channelId, mode, fulfillmentRef])
      : await this.databaseService.query(sql, [
          channelId,
          mode,
          fulfillmentRef,
        ]);

    if (res.rows.length === 1) {
      return res.rows[0].location_id;
    }
    return null;
  }

  async findActiveByChannel(
    channelId: string,
    client?: IDatabaseClient,
  ): Promise<string | null> {
    const db = client?.drizzle ?? this.databaseService.getDrizzle();
    if (db) {
      const rows = await db
        .select({
          location_id: schema.commercialFulfillmentRoutes.location_id,
        })
        .from(schema.commercialFulfillmentRoutes)
        .where(
          and(
            eq(schema.commercialFulfillmentRoutes.channel_id, channelId),
            eq(schema.commercialFulfillmentRoutes.active, true),
          ),
        );

      if (rows.length === 1) {
        return rows[0].location_id;
      }
      return null;
    }

    const sql = `
      SELECT location_id FROM inventory.commercial_fulfillment_routes
      WHERE channel_id = $1 AND active = true
    `;
    const res = client
      ? await client.query(sql, [channelId])
      : await this.databaseService.query(sql, [channelId]);

    if (res.rows.length === 1) {
      return res.rows[0].location_id;
    }
    return null;
  }
}
