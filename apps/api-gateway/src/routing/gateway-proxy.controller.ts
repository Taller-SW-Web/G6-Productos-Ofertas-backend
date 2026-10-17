import { All, Controller, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { GatewayProxy } from './gateway-proxy.js';

@Controller()
export class GatewayProxyController {
  constructor(private readonly proxy: GatewayProxy) {}
  @All('api/v1/{*path}')
  async forward(@Req() request: Request, @Res() response: Response) {
    await this.proxy.forward(request, response);
  }
}
