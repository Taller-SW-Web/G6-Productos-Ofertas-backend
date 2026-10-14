import { Injectable } from '@nestjs/common';
import { DatabaseService } from './database/database.service.js';

@Injectable()
export class InventorySvcService {
  constructor(private readonly databaseService: DatabaseService) {}

  getHealth() {
    return {
      status: 'ok',
      service: 'inventory-svc',
    };
  }

  async getHealthDetailed() {
    const db = await this.databaseService.isHealthy();
    return {
      status: 'ok',
      service: 'inventory-svc',
      database: db.healthy ? 'connected' : 'unreachable',
      timestamp: new Date().toISOString(),
    };
  }
}
