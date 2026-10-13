import { Injectable } from '@nestjs/common';

@Injectable()
export class BulkSvcService {
  getHealth() {
    return {
      status: 'ok',
      service: 'bulk-svc',
    };
  }
}