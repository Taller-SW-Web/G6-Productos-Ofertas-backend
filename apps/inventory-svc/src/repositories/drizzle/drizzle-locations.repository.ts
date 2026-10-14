import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service.js';
import { IDatabaseClient } from '../../database/database.interface.js';
import {
  ILocationsRepository,
  LocationEntity,
} from '../interfaces/locations.repository.interface.js';

@Injectable()
export class DrizzleLocationsRepository implements ILocationsRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async findActive(client?: IDatabaseClient): Promise<LocationEntity[]> {
    const sql = `
      SELECT id, code, name, type, external_ref, active
      FROM inventory.locations
      WHERE active = true
      ORDER BY code ASC
    `;
    const res = client
      ? await client.query(sql)
      : await this.databaseService.query(sql);

    return res.rows.map((r: any) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      type: r.type,
      external_ref: r.external_ref,
      active: Boolean(r.active),
    }));
  }
}
