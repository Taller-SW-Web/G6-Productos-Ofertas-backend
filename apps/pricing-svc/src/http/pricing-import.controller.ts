import {
  Body,
  Catch,
  Controller,
  Headers,
  HttpCode,
  HttpException,
  Inject,
  Post,
  Res,
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
  type ArgumentsHost,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { PricingImports } from '../application/pricing-imports.js';
import { PRICE_IMPORT_MAX_BYTES } from './pricing-import.csv.js';
import { PricingHttpError, PricingHttpFilter } from './pricing-http.error.js';
import { PricingReadGuard } from './pricing-read.guard.js';
import { PricingWriteAuthorization } from './pricing-write.authorization.js';

@Catch()
class PricingImportFilter extends PricingHttpFilter {
  override catch(error: unknown, host: ArgumentsHost) {
    if (error instanceof HttpException) {
      const status = error.getStatus();
      if (status === 413)
        error = new PricingHttpError(413, 'ARCHIVO_EXCEDE_LIMITE');
      if (status === 400) error = new PricingHttpError(400, 'ARCHIVO_INVALIDO');
    }
    super.catch(error, host);
  }
}

function upload(
  file: { buffer: Buffer } | undefined,
  body: Record<string, unknown> | undefined,
) {
  const allowPartial = body?.allow_partial;
  if (
    !file ||
    Object.keys(body ?? {}).some((field) => field !== 'allow_partial') ||
    (allowPartial !== undefined &&
      allowPartial !== 'true' &&
      allowPartial !== 'false')
  )
    throw new PricingHttpError(400, 'ARCHIVO_INVALIDO');
  if (file.buffer.length > PRICE_IMPORT_MAX_BYTES)
    throw new PricingHttpError(413, 'ARCHIVO_EXCEDE_LIMITE');
  return { file: file.buffer, allowPartial: allowPartial === 'true' };
}

@Controller('api/v1/precios/importaciones')
@UseGuards(PricingReadGuard)
@UseFilters(PricingImportFilter)
@UseInterceptors(
  FileInterceptor('archivo', {
    limits: {
      fileSize: PRICE_IMPORT_MAX_BYTES + 1,
      files: 1,
      fields: 1,
      fieldSize: 6,
      parts: 3,
    },
  }),
)
export class PricingImportController {
  constructor(
    @Inject(PricingImports) private readonly imports: PricingImports,
    @Inject(PricingWriteAuthorization)
    private readonly auth: PricingWriteAuthorization,
  ) {}

  @Post('prevalidar')
  @HttpCode(200)
  prevalidate(
    @UploadedFile() file: { buffer: Buffer } | undefined,
    @Body() body: Record<string, unknown> | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.imports.prevalidate(
      upload(file, body).file,
      String(response.getHeader('X-Correlation-Id')),
    );
  }

  @Post()
  @HttpCode(202)
  async create(
    @UploadedFile() file: { buffer: Buffer } | undefined,
    @Body() body: Record<string, unknown> | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const actor = await this.auth.authorize(
      'crearImportacionPrecios',
      authorization,
    );
    if (!key || !/^[!-~]{1,128}$/.test(key) || key.includes(','))
      throw new PricingHttpError(400, 'ARCHIVO_INVALIDO');
    const request = upload(file, body);
    return this.imports.admit(
      request.file,
      request.allowPartial,
      key,
      actor,
      String(response.getHeader('X-Correlation-Id')),
    );
  }
}
