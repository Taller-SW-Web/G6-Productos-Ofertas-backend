import { Injectable } from '@nestjs/common';

@Injectable()
export class TaxonomySvcService {
  getHealth() {
    return {
      status: 'ok',
      service: 'taxonomy-svc',
    };
  }
}
