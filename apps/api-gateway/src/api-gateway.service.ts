import { Injectable } from '@nestjs/common';

@Injectable()
export class ApiGatewayService {
  getHealth() {
    return {
      status: 'ok',
      service: 'api-gateway',
    };
  }
}
