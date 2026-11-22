import { Test } from '@nestjs/testing';
import request from 'supertest';
import { createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
import { BulkSvcController } from './bulk-svc.controller.js';
import { BulkSvcService } from './bulk-svc.service.js';
import { BulkReadinessService } from './health/bulk-readiness.service.js';
import { BulkImportService } from './bulk-import.service.js';
import { BulkStorageService } from './storage/bulk-storage.service.js';
import { BulkExportService } from './bulk-export.service.js';
import { BulkDomainError } from './domain/bulk.domain-error.js';
import { BulkUserBearerGuard } from './auth/bulk-user-bearer.guard.js';
import { BulkProblemFilter } from './http/bulk-problem.filter.js';
import type {
  NextFunction,
  Request as ExpressRequest,
  Response as ExpressResponse,
} from 'express';
import {
  createBulkTemplateCsv,
  BULK_TEMPLATE_HEADERS,
} from './domain/bulk-template-v2.js';

describe('Bulk HTTP import routes (isolated)', () => {
  it('receives multipart CSV and returns contractual admission DTO; rejects unsupported files', async () => {
    const batch = {
      batchId: '11111111-1111-4111-8111-111111111111',
      status: 'QUEUED',
      templateVersion: 2,
      correlationId: '22222222-2222-4222-8222-222222222222',
      totalRows: 1,
      completedRows: 0,
      failedRows: 0,
      needsReconciliation: false,
    };
    const rows = [
      {
        row: {
          rowId: '33333333-3333-4333-8333-333333333333',
          status: 'FAILED',
          appliedDomains: ['CATALOGO'],
          failedDomain: 'PRICING',
          needsReconciliation: true,
          errorCode: 'PRICE_REJECTED',
          errorDetail: ' \t=HYPERLINK("https://bad.test","open")',
        },
        steps: [
          {
            domain: 'CATALOGO',
            status: 'COMPLETED',
            errorCode: null,
            errorDetail: null,
          },
          {
            domain: 'PRICING',
            status: 'FAILED',
            errorCode: 'PRICE_REJECTED',
            errorDetail: 'error estable',
          },
        ],
      },
    ];
    const imports = {
      receiveImport: vi.fn().mockResolvedValue({ batch }),
      getSnapshot: vi.fn().mockResolvedValue({
        batch: {
          ...batch,
          status: 'COMPLETED',
          failedRows: 1,
          needsReconciliation: true,
        },
        rows,
      }),
      resumeBatch: vi
        .fn()
        .mockRejectedValue(
          new BulkDomainError(
            'DEPENDENCY_PENDING',
            'A new attempt is not approved.',
          ),
        ),
    };
    const downloadedCsv = Buffer.from('product_id\r\nprod-1\r\n', 'utf8');
    const completedExportId = '55555555-5555-4555-8555-555555555555';
    const unavailableExportId = '66666666-6666-4666-8666-666666666666';
    const storage = {
      put: vi.fn().mockResolvedValue('supabase://private/imports/test.csv'),
      get: vi.fn(async (contentRef: string) => {
        if (contentRef.endsWith('/unavailable.csv'))
          throw new BulkDomainError('STORAGE_UNAVAILABLE', 'storage down');
        return downloadedCsv;
      }),
    };
    const module = await Test.createTestingModule({
      controllers: [BulkSvcController],
      providers: [
        BulkSvcService,
        { provide: BulkImportService, useValue: imports },
        { provide: BulkStorageService, useValue: storage },
        {
          provide: BulkExportService,
          useValue: {
            create: vi.fn(async (format: string) => {
              if (format !== 'CSV' && format !== 'XLSX')
                throw new BulkDomainError('INVALID_INPUT', 'bad format');
              return {
                export_id: '44444444-4444-4444-8444-444444444444',
                status: 'QUEUED',
                formato: format,
              };
            }),
            get: vi.fn(async (id: string) => {
              if (id === 'not-a-uuid')
                throw new BulkDomainError('EXPORT_NOT_FOUND', 'missing');
              return {
                export_id: id,
                status: 'FAILED_GENERAL',
                formato: 'CSV',
              };
            }),
            download: vi.fn(async (id: string) => {
              if (id === completedExportId)
                return {
                  job: { exportId: id, format: 'CSV', status: 'COMPLETED' },
                  manifest: {
                    contentRef: 'supabase://private/exports/complete.csv',
                    role: 'RESULTADO_EXPORTACION',
                    format: 'CSV',
                  },
                };
              if (id === unavailableExportId)
                return {
                  job: { exportId: id, format: 'CSV', status: 'COMPLETED' },
                  manifest: {
                    contentRef: 'supabase://private/exports/unavailable.csv',
                    role: 'RESULTADO_EXPORTACION',
                    format: 'CSV',
                  },
                };
              if (id === '77777777-7777-4777-8777-777777777777')
                throw new BulkDomainError('EXPORT_NOT_FOUND', 'missing');
              throw new BulkDomainError('EXPORT_NOT_READY', 'not ready');
            }),
          },
        },
        {
          provide: BulkReadinessService,
          useValue: { check: vi.fn().mockResolvedValue(true) },
        },
      ],
    })
      .overrideGuard(BulkUserBearerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    const app = module.createNestApplication();
    app.useGlobalFilters(new BulkProblemFilter());
    app.use(
      (req: ExpressRequest, _res: ExpressResponse, next: NextFunction) => {
        Object.assign(req, {
          bulkActorSub: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        });
        next();
      },
    );
    await app.init();
    try {
      const template = await request(app.getHttpServer()).get(
        '/api/v1/carga-masiva/productos/plantilla?formato=CSV',
      );
      expect(template.status).toBe(200);
      expect(template.text).toBe(`${BULK_TEMPLATE_HEADERS.join(',')}\r\n`);
      const badFormat = await request(app.getHttpServer()).get(
        '/api/v1/carga-masiva/productos/plantilla?formato=TXT',
      );
      expect(badFormat.status).toBe(400);
      expect(badFormat.body).toMatchObject({ code: 'VALIDACION', status: 400 });
      expect(
        (
          await request(app.getHttpServer()).post(
            '/api/v1/carga-masiva/productos/plantilla',
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await request(app.getHttpServer()).get(
            '/api/v1/carga-masiva/productos/importaciones',
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await request(app.getHttpServer()).get(
            '/api/v1/carga-masiva/productos/importaciones/not-a-uuid',
          )
        ).body,
      ).toMatchObject({ code: 'LOTE_NO_ENCONTRADO', status: 404 });
      expect(
        (
          await request(app.getHttpServer()).get(
            '/api/v1/carga-masiva/productos/importaciones/unknown/private-proxy',
          )
        ).status,
      ).toBe(404);
      const csvValues = [
        'ALTA',
        '',
        '',
        'SKU-BASE',
        '',
        'Producto',
        'Descripción',
        'cat-1',
        'marca-1',
        'tipo-1',
        'false',
        '10.50',
        '[]',
        '',
        '',
        '0',
      ];
      const csv = Buffer.from(
        `${BULK_TEMPLATE_HEADERS.join(',')}\r\n${csvValues.join(',')}\r\n`,
      );
      const accepted = await request(app.getHttpServer())
        .post('/api/v1/carga-masiva/productos/importaciones')
        .field('template_version', '2')
        .attach('archivo', csv, 'items.csv');
      expect(accepted.status).toBe(202);
      expect(accepted.body).toMatchObject({
        batch_id: '11111111-1111-4111-8111-111111111111',
        status: 'QUEUED',
        template_version: 2,
      });
      const replay = await request(app.getHttpServer())
        .post('/api/v1/carga-masiva/productos/importaciones')
        .field('template_version', '2')
        .attach('archivo', csv, 'items.csv');
      expect(replay.status).toBe(202);
      expect(storage.put).toHaveBeenCalledTimes(2);
      expect(imports.receiveImport.mock.calls[1]?.[0]).toMatchObject({
        batchId: imports.receiveImport.mock.calls[0]?.[0].batchId,
        correlationId: imports.receiveImport.mock.calls[0]?.[0].correlationId,
      });
      const withoutVersion = await request(app.getHttpServer())
        .post('/api/v1/carga-masiva/productos/importaciones')
        .attach('archivo', csv, 'items.csv');
      expect(withoutVersion.status).toBe(202);
      expect(imports.receiveImport.mock.calls[2]?.[0].templateVersion).toBe(2);
      const wrongVersion = await request(app.getHttpServer())
        .post('/api/v1/carga-masiva/productos/importaciones')
        .field('template_version', '1')
        .attach('archivo', csv, 'items.csv');
      expect(wrongVersion.status).toBe(422);
      expect(wrongVersion.body).toMatchObject({
        code: 'PLANTILLA_INCOMPATIBLE',
        status: 422,
      });

      const status = await request(app.getHttpServer()).get(
        `/api/v1/carga-masiva/productos/importaciones/${batch.batchId}`,
      );
      expect(status.status).toBe(200);
      expect(status.body.rows[0]).toMatchObject({
        status: 'FAILED',
        applied_domains: ['CATALOGO'],
        steps: [
          { dominio: 'CATALOGO', status: 'COMPLETED' },
          { dominio: 'PRICING', status: 'FAILED' },
        ],
      });
      const report = await request(app.getHttpServer()).get(
        `/api/v1/carga-masiva/productos/importaciones/${batch.batchId}/reporte`,
      );
      expect(report.status).toBe(200);
      expect(report.headers['content-type']).toMatch(
        /^text\/csv; charset=utf-8/i,
      );
      expect(report.headers['content-disposition']).toBe(
        `attachment; filename="reporte-importacion-${batch.batchId}.csv"`,
      );
      expect(report.text).toContain('PRICE_REJECTED');
      expect(report.text).toContain("' \t=HYPERLINK");
      expect(report.text).toContain('""https://bad.test""');
      const resumed = await request(app.getHttpServer()).post(
        `/api/v1/carga-masiva/productos/importaciones/${batch.batchId}/reanudar`,
      );
      expect(resumed.status).toBe(503);
      expect(resumed.body.code).toBe('SERVICIO_NO_DISPONIBLE');
      expect(imports.getSnapshot).toHaveBeenCalledWith(
        batch.batchId,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      );

      const exportCreated = await request(app.getHttpServer())
        .post('/api/v1/carga-masiva/productos/exportaciones')
        .send({ formato: 'CSV' });
      expect(exportCreated.status).toBe(202);
      expect(exportCreated.body).toMatchObject({
        status: 'QUEUED',
        formato: 'CSV',
      });
      const exportStatus = await request(app.getHttpServer()).get(
        `/api/v1/carga-masiva/productos/exportaciones/${exportCreated.body.export_id}`,
      );
      expect(exportStatus.status).toBe(200);
      expect(exportStatus.body.status).toBe('FAILED_GENERAL');
      expect(
        (
          await request(app.getHttpServer()).get(
            `/api/v1/carga-masiva/productos/exportaciones/${exportCreated.body.export_id}/archivo`,
          )
        ).status,
      ).toBe(503);
      const downloaded = await request(app.getHttpServer()).get(
        `/api/v1/carga-masiva/productos/exportaciones/${completedExportId}/archivo`,
      );
      expect(downloaded.status).toBe(200);
      expect(downloaded.headers['content-type']).toMatch(/^text\/csv/i);
      expect(downloaded.headers['content-disposition']).toContain(
        `${completedExportId}.csv`,
      );
      expect(downloaded.text).toBe(downloadedCsv.toString('utf8'));
      const unavailable = await request(app.getHttpServer()).get(
        `/api/v1/carga-masiva/productos/exportaciones/${unavailableExportId}/archivo`,
      );
      expect(unavailable.status).toBe(503);
      expect(unavailable.body.code).toBe('SERVICIO_NO_DISPONIBLE');
      const missing = await request(app.getHttpServer()).get(
        '/api/v1/carga-masiva/productos/exportaciones/77777777-7777-4777-8777-777777777777/archivo',
      );
      expect(missing).toMatchObject({
        status: 404,
        body: { code: 'LOTE_NO_ENCONTRADO' },
      });
      expect(
        (
          await request(app.getHttpServer()).get(
            '/api/v1/carga-masiva/productos/exportaciones/not-a-uuid',
          )
        ).body,
      ).toMatchObject({ code: 'LOTE_NO_ENCONTRADO', status: 404 });
      expect(
        (
          await request(app.getHttpServer())
            .post('/api/v1/carga-masiva/productos/exportaciones')
            .send({ formato: 'PDF' })
        ).body,
      ).toMatchObject({ code: 'VALIDACION', status: 400 });
      const overLimit = await request(app.getHttpServer())
        .post('/api/v1/carga-masiva/productos/importaciones')
        .attach('archivo', Buffer.alloc(10_485_761), 'over-limit.csv');
      expect(overLimit.status).toBe(413);
      expect(overLimit.body).toMatchObject({
        code: 'ARCHIVO_EXCEDE_LIMITE',
        status: 413,
      });

      const invalid = await request(app.getHttpServer())
        .post('/api/v1/carga-masiva/productos/importaciones')
        .field('template_version', '2')
        .attach('archivo', createBulkTemplateCsv(), 'items.json');
      expect(invalid.status).toBe(422);
      expect(invalid.headers['content-type']).toContain(
        'application/problem+json',
      );
    } finally {
      await app.close();
    }
  });
});

describe('Bulk export HTTP authentication (isolated signed-key boundary)', () => {
  afterEach(() => {
    delete process.env.GATEWAY_DEMO_NO_AUTH_ENABLED;
    delete process.env.BULK_DEMO_GATEWAY_IPS;
    delete process.env.G7_JWT_PUBLIC_KEY;
    delete process.env.G7_JWT_ISSUER;
  });

  it('rejects missing identity and insufficient role, then admits a signed authorized user', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    process.env.GATEWAY_DEMO_NO_AUTH_ENABLED = 'false';
    process.env.G7_JWT_PUBLIC_KEY = publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString();
    process.env.G7_JWT_ISSUER = 'bulk-http-test-issuer';
    const token = (
      roles: string[],
      sub = '00000000-0000-4000-8000-000000000001',
    ) => {
      const encode = (value: object) =>
        Buffer.from(JSON.stringify(value)).toString('base64url');
      const header = encode({ alg: 'RS256', typ: 'JWT' });
      const claims = encode({
        iss: 'bulk-http-test-issuer',
        sub,
        tipo: 'acceso',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 600,
        jti: randomUUID(),
        roles,
      });
      const signer = createSign('RSA-SHA256');
      signer.update(`${header}.${claims}`);
      return `${header}.${claims}.${signer.sign(privateKey, 'base64url')}`;
    };
    const imports = {
      receiveImport: vi.fn(
        async (input: {
          batchId: string;
          ownerSub: string;
          correlationId: string;
        }) => ({
          batch: {
            batchId: input.batchId,
            status: 'QUEUED',
            templateVersion: 2,
            correlationId: '22222222-2222-4222-8222-222222222222',
          },
        }),
      ),
    };
    const module = await Test.createTestingModule({
      controllers: [BulkSvcController],
      providers: [
        BulkSvcService,
        { provide: BulkImportService, useValue: imports },
        {
          provide: BulkStorageService,
          useValue: {
            put: vi.fn().mockResolvedValue('private://imports/file.csv'),
          },
        },
        {
          provide: BulkExportService,
          useValue: { create: vi.fn().mockResolvedValue({ status: 'QUEUED' }) },
        },
        {
          provide: BulkReadinessService,
          useValue: { check: vi.fn().mockResolvedValue(true) },
        },
      ],
    }).compile();
    const app = module.createNestApplication();
    app.useGlobalFilters(new BulkProblemFilter());
    await app.init();
    try {
      const route = '/api/v1/carga-masiva/productos/exportaciones';
      expect(
        (
          await request(app.getHttpServer())
            .post(route)
            .send({ formato: 'CSV' })
        ).status,
      ).toBe(401);
      expect(
        (
          await request(app.getHttpServer())
            .post(route)
            .set('authorization', `Bearer ${token([])}`)
            .send({ formato: 'CSV' })
        ).status,
      ).toBe(403);
      expect(
        (
          await request(app.getHttpServer())
            .post(route)
            .set('authorization', `Bearer ${token(['GESTOR_COMERCIAL'])}`)
            .send({ formato: 'CSV' })
        ).status,
      ).toBe(202);
      const actorA = '00000000-0000-4000-8000-000000000001';
      const actorB = '00000000-0000-4000-8000-000000000002';
      const correlationA = '11111111-1111-4111-8111-111111111111';
      const correlationB = '22222222-2222-4222-8222-222222222222';
      const csvValues = [
        'ALTA',
        '',
        '',
        'SKU',
        '',
        'Nombre',
        'Descripcion',
        'cat',
        'marca',
        'tipo',
        'false',
        '1',
        '[]',
        '',
        '',
        '0',
      ];
      const csv = Buffer.from(
        `${BULK_TEMPLATE_HEADERS.join(',')}\r\n${csvValues.join(',')}\r\n`,
      );
      const submit = (sub: string, correlationId: string) =>
        request(app.getHttpServer())
          .post('/api/v1/carga-masiva/productos/importaciones')
          .set('authorization', `Bearer ${token(['GESTOR_COMERCIAL'], sub)}`)
          .set('x-correlation-id', correlationId)
          .attach('archivo', csv, 'items.csv');
      const identical = await submit(actorA, correlationA);
      const replay = await submit(actorA, correlationA);
      const separateIntent = await submit(actorA, correlationB);
      const otherActor = await submit(actorB, correlationA);
      expect([
        identical.status,
        replay.status,
        separateIntent.status,
        otherActor.status,
      ]).toEqual([202, 202, 202, 202]);
      const admissions = imports.receiveImport.mock.calls.map(
        ([input]) => input,
      );
      expect(admissions[0]?.batchId).toBe(admissions[1]?.batchId);
      expect(admissions[0]?.correlationId).toBe(admissions[1]?.correlationId);
      expect(admissions[2]?.batchId).not.toBe(admissions[0]?.batchId);
      expect(admissions[2]?.correlationId).toBe(correlationB);
      expect(admissions[3]?.batchId).not.toBe(admissions[0]?.batchId);
      expect(admissions.map(({ ownerSub }) => ownerSub)).toEqual([
        actorA,
        actorA,
        actorA,
        actorB,
      ]);
    } finally {
      await app.close();
    }
  });
});
