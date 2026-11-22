import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { PRICING_CONFIG, type PricingConfig } from '../config/environment.js';
import { changePrice, PriceRuleError, requireRule } from '../domain/price.js';
import { importDecision } from '../domain/import-policy.js';
import {
  PRICING_CATALOG_CONTEXT,
  type PricingCatalogContext,
} from '../http/commercial-prices.js';
import { importUpdate, parsePriceImport } from '../http/pricing-import.csv.js';
import { PricingHttpError } from '../http/pricing-http.error.js';
import { createPricingPriceChangedFacts } from '../messaging/pricing-fact.js';
import type { PricingTransaction } from '../persistence/pricing.database.js';
import { PricingRepository } from '../persistence/pricing.repository.js';
import { bulkPriceJobs, bulkPriceRows } from '../persistence/pricing.schema.js';
import { PricingMutations } from './pricing-mutations.js';

type ImportRow = ReturnType<typeof parsePriceImport>[number];
type ImportJob = typeof bulkPriceJobs.$inferSelect;

async function rowError(validate: () => Promise<void>) {
  try {
    await validate();
    return null;
  } catch (error) {
    if (error instanceof PriceRuleError) return error.code;
    throw error;
  }
}

@Injectable()
export class PricingImports implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PricingImports.name);
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private stopping = false;
  private importSchemaReady = false;

  constructor(
    @Inject(PricingRepository) private readonly repository: PricingRepository,
    @Inject(PricingMutations) private readonly mutations: PricingMutations,
    @Inject(PRICING_CATALOG_CONTEXT)
    private readonly catalog: PricingCatalogContext,
    @Inject(PRICING_CONFIG) private readonly config: PricingConfig,
  ) {}

  private async contexts(
    rows: Pick<ImportRow, 'sku' | 'code'>[],
    correlationId: string,
  ) {
    const skus = [
      ...new Set(rows.flatMap(({ sku, code }) => (!code && sku ? [sku] : []))),
    ];
    const resolved = new Map<string, string>();
    if (!skus.length) return resolved;
    if (
      this.catalog.batchMode !== 'G7_AUTHENTICATED' ||
      !this.catalog.resolveBatch
    )
      throw new PricingHttpError(503, 'SERVICIO_NO_DISPONIBLE');
    const chunks: string[][] = [];
    for (let i = 0; i < skus.length; i += 100)
      chunks.push(skus.slice(i, i + 100));
    const batches = await Promise.all(
      chunks.map((chunk) => this.catalog.resolveBatch!(chunk, correlationId)),
    );
    for (const [batchIndex, contexts] of batches.entries()) {
      const chunk = chunks[batchIndex];
      if (contexts.length !== chunk.length)
        throw new PricingHttpError(503, 'SERVICIO_NO_DISPONIBLE');
      for (const [index, context] of contexts.entries()) {
        if (context === null) continue;
        if (context.sku !== chunk[index] || !context.productId)
          throw new PricingHttpError(503, 'SERVICIO_NO_DISPONIBLE');
        if (context.active && context.eligible)
          resolved.set(context.sku, context.productId);
      }
    }
    return resolved;
  }

  async prevalidate(file: Buffer, correlationId: string) {
    const rows = parsePriceImport(file);
    const contexts = await this.contexts(rows, correlationId);
    const definitions = await this.repository.readSkuDefinitions([
      ...contexts.keys(),
    ]);
    const errors: {
      row_id: string;
      sku: string | null;
      status: 'FAILED';
      code: string;
    }[] = [];
    const now = new Date();
    for (const row of rows) {
      const code =
        row.code ??
        (await rowError(async () => {
          requireRule(
            row.sku !== null && contexts.has(row.sku),
            'PRECIO_NO_ENCONTRADO',
          );
          const { channelId, expectedVersion, input } = importUpdate(
            row.rowInput,
          );
          const loaded = definitions.get(JSON.stringify([row.sku, channelId]));
          requireRule(loaded !== undefined, 'PRECIO_NO_ENCONTRADO');
          changePrice(
            {
              target: { sku: row.sku, productId: null },
              channelId,
              priceVersion: loaded.definition.priceVersion,
              validities: loaded.validities,
            },
            { ...input, usuarioId: null },
            expectedVersion,
            now,
          );
        }));
      if (code)
        errors.push({
          row_id: row.rowId,
          sku: row.sku,
          status: 'FAILED',
          code,
        });
    }
    return { valid: errors.length === 0, total_rows: rows.length, errors };
  }

  async admit(
    file: Buffer,
    allowPartial: boolean,
    key: string,
    actor: string,
    correlationId: string,
  ) {
    if (
      this.catalog.batchMode !== 'G7_AUTHENTICATED' ||
      !this.catalog.resolveBatch
    )
      throw new PricingHttpError(503, 'SERVICIO_NO_DISPONIBLE');
    const requestHash = createHash('sha256')
      .update(allowPartial ? '1' : '0')
      .update(file)
      .digest('hex');
    const job = await this.repository.transaction(async (tx) => {
      const [prior] = await tx
        .select()
        .from(bulkPriceJobs)
        .where(
          and(
            eq(bulkPriceJobs.usuarioId, actor),
            eq(bulkPriceJobs.idempotencyKey, key),
          ),
        );
      if (prior) {
        requireRule(prior.requestHash === requestHash, 'IDEMPOTENCY_CONFLICT');
        return prior;
      }
      const rows = parsePriceImport(file);
      const [inserted] = await tx
        .insert(bulkPriceJobs)
        .values({
          allowPartial,
          correlationId,
          totalRows: rows.length,
          usuarioId: actor,
          idempotencyKey: key,
          requestHash,
        })
        .onConflictDoNothing({
          target: [bulkPriceJobs.usuarioId, bulkPriceJobs.idempotencyKey],
        })
        .returning();
      if (!inserted) {
        const [winner] = await tx
          .select()
          .from(bulkPriceJobs)
          .where(
            and(
              eq(bulkPriceJobs.usuarioId, actor),
              eq(bulkPriceJobs.idempotencyKey, key),
            ),
          );
        requireRule(
          winner?.requestHash === requestHash,
          'IDEMPOTENCY_CONFLICT',
        );
        return winner;
      }
      await tx
        .insert(bulkPriceRows)
        .values(rows.map((row) => ({ ...row, batchId: inserted.id })));
      return inserted;
    });
    this.wake();
    return {
      batch_id: job.id,
      status: 'QUEUED' as const,
      allow_partial: job.allowPartial,
      correlation_id: job.correlationId,
    };
  }

  async processNext() {
    return this.repository.transaction(async (tx) => {
      // La migración de importación puede aplicarse después de desplegar lecturas.
      if (!this.importSchemaReady) {
        const { rows } = await tx.execute<{ compatible: boolean }>(sql`
          SELECT count(*) = 2 AS compatible
          FROM information_schema.columns
          WHERE table_schema = 'pricing' AND table_name = 'bulk_price_jobs'
            AND column_name IN ('idempotency_key', 'request_hash')
        `);
        if (!rows[0]?.compatible) return false;
        this.importSchemaReady = true;
      }
      const [job] = await tx
        .select()
        .from(bulkPriceJobs)
        .where(
          and(
            isNotNull(bulkPriceJobs.idempotencyKey),
            eq(bulkPriceJobs.status, 'QUEUED'),
          ),
        )
        .orderBy(asc(bulkPriceJobs.createdAt), asc(bulkPriceJobs.id))
        .limit(1)
        .for('update', { skipLocked: true });
      if (!job) return false;
      const rows = await tx
        .select()
        .from(bulkPriceRows)
        .where(eq(bulkPriceRows.batchId, job.id))
        .orderBy(asc(bulkPriceRows.sku), asc(bulkPriceRows.rowId));
      const knownRejection = !job.allowPartial && rows.some((row) => row.code);
      const codes = rows.map((row) => row.code);
      try {
        if (!knownRejection) {
          const contexts = await this.contexts(rows, job.correlationId);
          await tx.transaction(async (work) => {
            for (const [index, row] of rows.entries()) {
              const apply = (target: PricingTransaction) =>
                this.apply(target, row, job, contexts);
              if (!codes[index])
                codes[index] = await rowError(() =>
                  job.allowPartial ? work.transaction(apply) : apply(work),
                );
              if (codes[index] && !job.allowPartial) throw rejectedBatch;
            }
          });
        }
      } catch (error) {
        if (error !== rejectedBatch) throw error;
      }
      const result = importDecision(
        job.allowPartial,
        codes.map((code) => code === null),
      );
      const now = new Date();
      const groups = new Map<string | null, string[]>();
      for (const [index, row] of rows.entries()) {
        const code = result.commitRows[index]
          ? null
          : (codes[index] ?? 'VALIDACION');
        const ids = groups.get(code) ?? [];
        ids.push(row.id);
        groups.set(code, ids);
      }
      for (const [code, ids] of groups) {
        await tx
          .update(bulkPriceRows)
          .set({
            status: code === null ? 'COMPLETED' : 'FAILED',
            code,
            updatedAt: now,
          })
          .where(inArray(bulkPriceRows.id, ids));
      }
      await tx
        .update(bulkPriceJobs)
        .set({
          status: result.status,
          completedRows: result.completedRows,
          failedRows: result.failedRows,
          updatedAt: now,
        })
        .where(eq(bulkPriceJobs.id, job.id));
      return true;
    });
  }

  private async apply(
    tx: PricingTransaction,
    row: typeof bulkPriceRows.$inferSelect,
    job: ImportJob,
    contexts: Map<string, string>,
  ) {
    requireRule(row.sku !== null, 'VALIDACION');
    const productId = contexts.get(row.sku);
    requireRule(productId !== undefined, 'PRECIO_NO_ENCONTRADO');
    const { input, channelId, expectedVersion } = importUpdate(row.rowInput);
    const at = new Date();
    await this.mutations.updateInTransaction(
      tx,
      { sku: row.sku },
      channelId,
      { ...input, usuarioId: job.usuarioId },
      expectedVersion,
      at,
      (before, after) =>
        createPricingPriceChangedFacts(before, after, {
          actor: job.usuarioId,
          batchId: job.id,
          operationId: row.id,
          correlationId: job.correlationId,
          at,
          operation: 'crearImportacionPrecios',
          productId,
        }),
    );
  }

  onApplicationBootstrap() {
    if (
      this.config.securityMode !== 'G7_AUTHENTICATED' ||
      this.catalog.batchMode !== 'G7_AUTHENTICATED'
    )
      return;
    this.timer = setInterval(() => this.wake(), 2000);
    this.timer.unref();
    this.wake();
  }

  private wake() {
    if (this.stopping || this.active || !this.timer) return;
    this.active = this.processNext()
      .then(() => undefined)
      .catch(() => {
        this.logger.warn('Importación de precios pendiente de recuperación.');
      })
      .finally(() => {
        this.active = undefined;
      });
  }

  async onModuleDestroy() {
    this.stopping = true;
    clearInterval(this.timer);
    await this.active;
  }
}

const rejectedBatch = new Error('Lote de precios rechazado.');
