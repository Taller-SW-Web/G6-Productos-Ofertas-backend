import { Injectable } from '@nestjs/common';

@Injectable()
export class PromotionsSvcService {
  getHealth() {
    return {
      status: 'ok',
      service: 'promotions-svc',
    };
  }
}