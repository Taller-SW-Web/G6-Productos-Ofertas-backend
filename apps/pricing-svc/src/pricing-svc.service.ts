import { Injectable } from '@nestjs/common';

@Injectable()
export class PricingSvcService {
  getHealth() {
    return {
      status: 'ok',
      service: 'pricing-svc',
    };
  }
}
