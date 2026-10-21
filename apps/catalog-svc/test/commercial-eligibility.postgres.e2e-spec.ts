import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import {
  COMMERCIAL_ELIGIBILITY,
  type CommercialEligibilityPolicy,
} from '../src/commercial-eligibility.js';
import { Database } from '../src/database.js';
import {
  CATALOG_READ_DEMO,
  CATALOG_MARKETPLACE_PREVIEW,
} from '../src/catalog-read-demo.js';

function writeEvidence(value: Readonly<Record<string, string | number>>): void {
  process.stdout.write(JSON.stringify(value) + '\n');
}

describe.skipIf(process.env.G6_READONLY_INTEGRATION !== 'catalog')(
  'Catalog commercial eligibility on configured PostgreSQL (read only)',
  () => {
    it('queries the candidate table or fails closed when it is unavailable', async () => {
      const app = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(CATALOG_READ_DEMO)
        .useValue({ enabled: false })
        .overrideProvider(CATALOG_MARKETPLACE_PREVIEW)
        .useValue(false)
        .compile()
        .then((module) => module.createNestApplication());

      try {
        await app.init();
        const database = app.get(Database);
        await database.verifyIdentity();

        const relation = await database.read((db) =>
          db.execute(
            sql`SELECT to_regclass('catalog.sku_channel_eligibility')::text AS relation`,
          ),
        );
        const policy = app.get<CommercialEligibilityPolicy>(
          COMMERCIAL_ELIGIBILITY,
        );

        if (relation.rows[0]?.relation == null) {
          await expect(policy.resolve('MARKETPLACE')).rejects.toMatchObject({
            status: 503,
            message: 'Servicio temporalmente no disponible',
          });
          for (const path of [
            '/api/v1/productos?canal=MARKETPLACE',
            '/api/v1/productos/por-slug/integration-probe?canal=MARKETPLACE',
          ]) {
            const response = await request(app.getHttpServer())
              .get(path)
              .expect(401);
            expect(response.body.code).toBe('TOKEN_INVALIDO');
          }
          writeEvidence({
            evidence: 'catalog-commercial-eligibility-postgres',
            outcome:
              'candidate-table-absent-adapter-503-unauthenticated-endpoints-401',
          });
          return;
        }

        try {
          const selection = await policy.resolve('MARKETPLACE');
          expect(Array.isArray(selection.productIds)).toBe(true);
          expect(Array.isArray(selection.variantIds)).toBe(true);
          expect(new Set(selection.productIds).size).toBe(
            selection.productIds.length,
          );
          expect(new Set(selection.variantIds).size).toBe(
            selection.variantIds.length,
          );
          writeEvidence({
            evidence: 'catalog-commercial-eligibility-postgres',
            outcome: 'select-succeeded',
            productCount: selection.productIds.length,
            variantCount: selection.variantIds.length,
          });
        } catch (error) {
          // A present table with insufficient runtime SELECT privilege is also
          // a supported fail-closed state for this candidate integration.
          expect(error).toMatchObject({
            status: 503,
            message: 'Servicio temporalmente no disponible',
          });
          writeEvidence({
            evidence: 'catalog-commercial-eligibility-postgres',
            outcome: 'select-unavailable-fails-closed',
          });
        }
      } finally {
        await app.close();
      }
    }, 30000);
  },
);
