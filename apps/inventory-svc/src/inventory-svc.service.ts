import { Injectable } from '@nestjs/common';

@Injectable()
export class InventorySvcService {
  getHealth() {
    return {
      status: 'ok',
      service: 'inventory-svc',
    };
  }
}
