import { Injectable } from '@nestjs/common';

@Injectable()
export class CombosSvcService {
  getHealth() {
    return {
      status: 'ok',
      service: 'combos-svc',
    };
  }
}