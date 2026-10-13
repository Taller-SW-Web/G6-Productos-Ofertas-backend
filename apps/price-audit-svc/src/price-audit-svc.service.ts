import { Injectable } from '@nestjs/common';

@Injectable()
export class PriceAuditSvcService {
  getHealth() {
    return {
      status: 'ok',
      service: 'price-audit-svc',
    };
  }
}
