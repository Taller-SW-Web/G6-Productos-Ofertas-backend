import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { TaxonomySvcModule } from '../src/taxonomy-svc.module.js';
import { Database } from '../src/database.js';
import { TAXONOMY_REPOSITORY } from '../src/taxonomy.repository.js';
import { PostgresTaxonomyRepository } from '../src/postgres-taxonomy.repository.js';

describe.skipIf(process.env.G6_READONLY_INTEGRATION !== 'taxonomy')(
  'Taxonomy real PostgreSQL SELECT',
  () => {
    let app: INestApplication;
    let db: Database;
    beforeAll(async () => {
      app = (
        await Test.createTestingModule({
          imports: [TaxonomySvcModule],
        }).compile()
      ).createNestApplication();
      await app.init();
      db = app.get(Database);
      await db.verifyIdentity();
    }, 30000);
    afterAll(async () => {
      await app?.close();
    });
    it('Nest → repository → Drizzle → own PostgreSQL; exact active-only projection', async () => {
      const repo = app.get<PostgresTaxonomyRepository>(TAXONOMY_REPOSITORY);
      expect(await repo.readiness()).toBe(true);
      for (const [path, key, table] of [
        ['categorias', 'categories', 'categories'],
        ['marcas', 'brands', 'brands'],
      ]) {
        const response = await request(app.getHttpServer())
          .get('/api/v1/' + path)
          .expect(200);
        const rows: Record<string, unknown>[] = response.body[key];
        const count = await db.read((d) =>
          d.execute(
            sql`SELECT count(*)::integer AS n FROM ${sql.identifier('taxonomy')}.${sql.identifier(table)}
          WHERE estado = ${'ACTIVO'}`,
          ),
        );
        expect(rows.length === count.rows[0].n).toBe(true);
        expect(rows.every((r) => r.status === 'ACTIVA')).toBe(true);
        const allowed =
          path === 'categorias'
            ? ['categoria_id', 'parent_id', 'name', 'status']
            : [
                'marca_id',
                'name',
                'description',
                'logo_url',
                'country_code',
                'status',
              ];
        expect(
          rows.every((r) => Object.keys(r).every((k) => allowed.includes(k))),
        ).toBe(true);
      }
    }, 30000);
    it('returns sanitized validation error with real provider installed', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/categorias?estado=INACTIVO')
        .expect(400);
      expect(response.body.code === 'VALIDACION').toBe(true);
    });
  },
);
