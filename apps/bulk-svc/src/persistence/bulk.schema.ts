import {
  boolean,
  check,
  char,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const bulk = pgSchema('bulk');

export const jobStatus = bulk.enum('job_status', [
  'QUEUED',
  'PROCESSING',
  'COMPLETED',
  'FAILED_GENERAL',
]);
export const rowStatus = bulk.enum('row_status', [
  'PENDING',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
]);
export const stepStatus = bulk.enum('step_status', [
  'PENDING',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
]);

const tz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'date' });

export const fileManifests = bulk.table(
  'file_manifests',
  {
    id: uuid('id').defaultRandom().notNull(),
    role: text('role').notNull(),
    format: text('format').notNull(),
    contentRef: text('content_ref').notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
    updatedAt: tz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'pk_file_manifests', columns: [t.id] }),
    check(
      'ck_file_manifests_role',
      sql`${t.role} IN ('ENTRADA_IMPORTACION','REPORTE_IMPORTACION','RESULTADO_EXPORTACION')`,
    ),
    check('ck_file_manifests_format', sql`${t.format} IN ('CSV','XLSX')`),
    check(
      'ck_file_manifests_report_csv',
      sql`${t.role} <> 'REPORTE_IMPORTACION' OR ${t.format} = 'CSV'`,
    ),
  ],
);

export const batchJobs = bulk.table(
  'batch_jobs',
  {
    id: uuid('id').defaultRandom().notNull(),
    batchId: uuid('batch_id').notNull(),
    // Nullable only for historical rows; public reads never expose null-owned jobs.
    ownerSub: uuid('owner_sub'),
    inputFileId: uuid('input_file_id').notNull(),
    reportFileId: uuid('report_file_id'),
    status: jobStatus('status').notNull().default('QUEUED'),
    templateVersion: integer('template_version').notNull(),
    correlationId: uuid('correlation_id').notNull(),
    totalRows: integer('total_rows').notNull().default(0),
    completedRows: integer('completed_rows').notNull().default(0),
    failedRows: integer('failed_rows').notNull().default(0),
    needsReconciliation: boolean('needs_reconciliation')
      .notNull()
      .default(false),
    createdAt: tz('created_at').notNull().defaultNow(),
    updatedAt: tz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'pk_batch_jobs', columns: [t.id] }),
    foreignKey({
      name: 'fk_batch_jobs_input_file_id',
      columns: [t.inputFileId],
      foreignColumns: [fileManifests.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fk_batch_jobs_report_file_id',
      columns: [t.reportFileId],
      foreignColumns: [fileManifests.id],
    }).onDelete('restrict'),
    unique('uq_batch_jobs_batch_id').on(t.batchId),
    uniqueIndex('uq_batch_jobs_owner_correlation')
      .on(t.ownerSub, t.correlationId)
      .where(sql`${t.ownerSub} IS NOT NULL`),
    index('ix_batch_jobs_owner_created_at').on(t.ownerSub, t.createdAt),
    unique('uq_batch_jobs_report_file_id').on(t.reportFileId),
    check('ck_batch_jobs_template_version', sql`${t.templateVersion} > 0`),
    check('ck_batch_jobs_total_rows', sql`${t.totalRows} >= 0`),
    check('ck_batch_jobs_completed_rows', sql`${t.completedRows} >= 0`),
    check('ck_batch_jobs_failed_rows', sql`${t.failedRows} >= 0`),
    check(
      'ck_batch_jobs_completed_lte_total',
      sql`${t.completedRows} <= ${t.totalRows}`,
    ),
    check(
      'ck_batch_jobs_failed_lte_total',
      sql`${t.failedRows} <= ${t.totalRows}`,
    ),
    check(
      'ck_batch_jobs_terminal_lte_total',
      sql`${t.completedRows} + ${t.failedRows} <= ${t.totalRows}`,
    ),
    check(
      'ck_batch_jobs_completed_terminal',
      sql`${t.status} <> 'COMPLETED' OR ${t.completedRows} + ${t.failedRows} = ${t.totalRows}`,
    ),
    check(
      'ck_batch_jobs_completed_reconciliation',
      sql`${t.status} <> 'COMPLETED' OR ${t.needsReconciliation} = (${t.failedRows} > 0)`,
    ),
    index('ix_batch_jobs_input_file_id').on(t.inputFileId),
    index('ix_batch_jobs_status_created_at').on(t.status, t.createdAt),
    index('ix_batch_jobs_reconciliation')
      .on(t.updatedAt)
      .where(sql`${t.needsReconciliation} = true`),
  ],
);

/** Opaque private claim-check identities; Storage paths remain Bulk-owned. */
export const contentDocuments = bulk.table(
  'content_documents',
  {
    contentId: uuid('content_id').notNull(),
    batchId: uuid('batch_id').notNull(),
    batchOperationId: uuid('batch_operation_id').notNull(),
    contentRef: text('content_ref').notNull(),
    sha256: text('sha256').notNull(),
    byteLength: integer('byte_length').notNull(),
    contentType: text('content_type').notNull().default('application/json'),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'pk_content_documents', columns: [t.contentId] }),
    foreignKey({
      name: 'fk_content_documents_batch_id',
      columns: [t.batchId],
      foreignColumns: [batchJobs.batchId],
    }).onDelete('restrict'),
    unique('uq_content_documents_batch_operation').on(
      t.batchId,
      t.batchOperationId,
    ),
    check('ck_content_documents_sha256', sql`${t.sha256} ~ '^[a-f0-9]{64}$'`),
    check('ck_content_documents_byte_length', sql`${t.byteLength} > 0`),
    check(
      'ck_content_documents_content_type',
      sql`${t.contentType} = 'application/json'`,
    ),
    index('ix_content_documents_batch_id').on(t.batchId),
  ],
);

export const batchRows = bulk.table(
  'batch_rows',
  {
    id: uuid('id').defaultRandom().notNull(),
    batchJobId: uuid('batch_job_id').notNull(),
    rowId: uuid('row_id').notNull(),
    status: rowStatus('status').notNull().default('PENDING'),
    requiredDomains: text('required_domains').array().notNull(),
    appliedDomains: text('applied_domains')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    failedDomain: text('failed_domain'),
    needsReconciliation: boolean('needs_reconciliation')
      .notNull()
      .default(false),
    errorCode: text('error_code'),
    errorDetail: text('error_detail'),
    createdAt: tz('created_at').notNull().defaultNow(),
    updatedAt: tz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'pk_batch_rows', columns: [t.id] }),
    foreignKey({
      name: 'fk_batch_rows_batch_job_id',
      columns: [t.batchJobId],
      foreignColumns: [batchJobs.id],
    }).onDelete('cascade'),
    unique('uq_batch_rows_batch_row').on(t.batchJobId, t.rowId),
    check(
      'ck_batch_rows_required_cardinality',
      sql`cardinality(${t.requiredDomains}) BETWEEN 1 AND 3`,
    ),
    check(
      'ck_batch_rows_required_values',
      sql`${t.requiredDomains} <@ ARRAY['CATALOGO','PRICING','INVENTARIO']::text[]`,
    ),
    check(
      'ck_batch_rows_applied_values',
      sql`${t.appliedDomains} <@ ARRAY['CATALOGO','PRICING','INVENTARIO']::text[]`,
    ),
    check(
      'ck_batch_rows_required_no_null',
      sql`array_position(${t.requiredDomains}, NULL) IS NULL`,
    ),
    check(
      'ck_batch_rows_applied_no_null',
      sql`array_position(${t.appliedDomains}, NULL) IS NULL`,
    ),
    check(
      'ck_batch_rows_required_unique',
      sql`cardinality(${t.requiredDomains}) = CASE WHEN 'CATALOGO' = ANY(${t.requiredDomains}) THEN 1 ELSE 0 END + CASE WHEN 'PRICING' = ANY(${t.requiredDomains}) THEN 1 ELSE 0 END + CASE WHEN 'INVENTARIO' = ANY(${t.requiredDomains}) THEN 1 ELSE 0 END`,
    ),
    check(
      'ck_batch_rows_applied_unique',
      sql`cardinality(${t.appliedDomains}) = CASE WHEN 'CATALOGO' = ANY(${t.appliedDomains}) THEN 1 ELSE 0 END + CASE WHEN 'PRICING' = ANY(${t.appliedDomains}) THEN 1 ELSE 0 END + CASE WHEN 'INVENTARIO' = ANY(${t.appliedDomains}) THEN 1 ELSE 0 END`,
    ),
    check(
      'ck_batch_rows_applied_subset',
      sql`${t.appliedDomains} <@ ${t.requiredDomains}`,
    ),
    check(
      'ck_batch_rows_failed_domain_value',
      sql`${t.failedDomain} IS NULL OR ${t.failedDomain} IN ('CATALOGO','PRICING','INVENTARIO')`,
    ),
    check(
      'ck_batch_rows_failed_domain_required',
      sql`${t.failedDomain} IS NULL OR ${t.failedDomain} = ANY(${t.requiredDomains})`,
    ),
    check(
      'ck_batch_rows_failed_domain_not_applied',
      sql`${t.failedDomain} IS NULL OR NOT (${t.failedDomain} = ANY(${t.appliedDomains}))`,
    ),
    check(
      'ck_batch_rows_completed_consistency',
      sql`${t.status} <> 'COMPLETED' OR (${t.failedDomain} IS NULL AND ${t.needsReconciliation} = false AND ${t.requiredDomains} <@ ${t.appliedDomains} AND ${t.appliedDomains} <@ ${t.requiredDomains})`,
    ),
    check(
      'ck_batch_rows_failed_has_domain',
      sql`${t.status} <> 'FAILED' OR ${t.failedDomain} IS NOT NULL`,
    ),
    check(
      'ck_batch_rows_failed_domain_requires_failed',
      sql`${t.failedDomain} IS NULL OR ${t.status} = 'FAILED'`,
    ),
    check(
      'ck_batch_rows_reconciliation',
      sql`${t.needsReconciliation} = false OR (${t.status} = 'FAILED' AND cardinality(${t.appliedDomains}) > 0)`,
    ),
    index('ix_batch_rows_batch_status').on(t.batchJobId, t.status),
    index('ix_batch_rows_reconciliation')
      .on(t.batchJobId)
      .where(sql`${t.needsReconciliation} = true`),
    index('ix_batch_rows_failed_domain')
      .on(t.batchJobId, t.failedDomain)
      .where(sql`${t.failedDomain} IS NOT NULL`),
  ],
);

export const rowDomainSteps = bulk.table(
  'row_domain_steps',
  {
    id: uuid('id').defaultRandom().notNull(),
    batchRowId: uuid('batch_row_id').notNull(),
    domain: text('domain').notNull(),
    status: stepStatus('status').notNull().default('PENDING'),
    errorCode: text('error_code'),
    errorDetail: text('error_detail'),
    createdAt: tz('created_at').notNull().defaultNow(),
    updatedAt: tz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'pk_row_domain_steps', columns: [t.id] }),
    foreignKey({
      name: 'fk_row_domain_steps_batch_row_id',
      columns: [t.batchRowId],
      foreignColumns: [batchRows.id],
    }).onDelete('cascade'),
    unique('uq_row_domain_steps_row_domain').on(t.batchRowId, t.domain),
    check(
      'ck_row_domain_steps_domain',
      sql`${t.domain} IN ('CATALOGO','PRICING','INVENTARIO')`,
    ),
    index('ix_row_domain_steps_status_updated_at').on(t.status, t.updatedAt),
  ],
);

export const exportJobs = bulk.table(
  'export_jobs',
  {
    id: uuid('id').defaultRandom().notNull(),
    exportId: uuid('export_id').notNull(),
    // Nullable only for historical rows; public reads never expose null-owned jobs.
    ownerSub: uuid('owner_sub'),
    status: jobStatus('status').notNull().default('QUEUED'),
    format: text('format').notNull(),
    outputFileId: uuid('output_file_id'),
    createdAt: tz('created_at').notNull().defaultNow(),
    completedAt: tz('completed_at'),
    updatedAt: tz('updated_at').notNull().defaultNow(),
    claimToken: uuid('claim_token'),
    leaseUntil: tz('lease_until'),
  },
  (t) => [
    primaryKey({ name: 'pk_export_jobs', columns: [t.id] }),
    foreignKey({
      name: 'fk_export_jobs_output_file_id',
      columns: [t.outputFileId],
      foreignColumns: [fileManifests.id],
    }).onDelete('restrict'),
    unique('uq_export_jobs_export_id').on(t.exportId),
    index('ix_export_jobs_owner_created_at').on(t.ownerSub, t.createdAt),
    unique('uq_export_jobs_output_file_id').on(t.outputFileId),
    check('ck_export_jobs_format', sql`${t.format} IN ('CSV','XLSX')`),
    check(
      'ck_export_jobs_completed_file',
      sql`${t.status} <> 'COMPLETED' OR (${t.outputFileId} IS NOT NULL AND ${t.completedAt} IS NOT NULL)`,
    ),
    index('ix_export_jobs_status_created_at').on(t.status, t.createdAt),
  ],
);

export const outbox = bulk.table(
  'outbox',
  {
    id: uuid('id').defaultRandom().notNull(),
    messageId: text('message_id').notNull(),
    eventName: text('event_name').notNull(),
    kind: text('kind').notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
    correlationId: text('correlation_id').notNull(),
    causationId: text('causation_id'),
    operationId: uuid('operation_id'),
    occurredAt: tz('occurred_at').notNull(),
    payload: jsonb('payload').notNull().$type<Record<string, unknown>>(),
    publishedAt: tz('published_at'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'pk_outbox', columns: [t.id] }),
    unique('uq_outbox_message_id').on(t.messageId),
    check('ck_outbox_kind', sql`${t.kind} IN ('command','event','result')`),
    check('ck_outbox_schema_version', sql`${t.schemaVersion} > 0`),
    check('ck_outbox_attempts', sql`${t.attempts} >= 0`),
    // A Catalog command remains pending until its correlated result proves
    // that the primary consumer handled it; confirms alone are insufficient.
    index('ix_outbox_pending').on(t.publishedAt, t.occurredAt),
    uniqueIndex('uq_outbox_initial_operation_event')
      .on(t.operationId, t.eventName)
      .where(sql`${t.causationId} IS NULL`),
    uniqueIndex('uq_outbox_retry_causation_event')
      .on(t.operationId, t.eventName, t.causationId)
      .where(sql`${t.causationId} IS NOT NULL`),
  ],
);

/** Durable per-recipient delivery for the H5 Basic queue topology. */
export const outboxDeliveries = bulk.table(
  'outbox_delivery',
  {
    messageId: text('message_id').notNull(),
    destination: text('destination').notNull(),
    attempts: integer('attempts').notNull().default(0),
    createdAt: tz('created_at').notNull().defaultNow(),
    availableAt: tz('available_at').notNull().defaultNow(),
    leaseToken: uuid('lease_token'),
    publishedAt: tz('published_at'),
    lastError: text('last_error'),
  },
  (t) => [
    primaryKey({
      name: 'pk_outbox_delivery',
      columns: [t.messageId, t.destination],
    }),
    foreignKey({
      name: 'fk_outbox_delivery_message_id',
      columns: [t.messageId],
      foreignColumns: [outbox.messageId],
    }),
    check(
      'ck_outbox_delivery_destination',
      sql`${t.destination} = 'g6.catalog.from.bulk'`,
    ),
    check('ck_outbox_delivery_attempts', sql`${t.attempts} >= 0`),
    check(
      'ck_outbox_delivery_lease',
      sql`${t.publishedAt} IS NULL OR ${t.leaseToken} IS NULL`,
    ),
    index('ix_outbox_delivery_pending')
      .on(t.availableAt, t.createdAt, t.messageId, t.destination)
      .where(sql`${t.publishedAt} IS NULL`),
  ],
);

export const inbox = bulk.table(
  'inbox',
  {
    id: uuid('id').defaultRandom().notNull(),
    messageId: text('message_id').notNull(),
    handler: text('handler').notNull(),
    eventName: text('event_name').notNull(),
    correlationId: text('correlation_id'),
    payload: jsonb('payload').notNull().$type<Record<string, unknown>>(),
    result: text('result').notNull(),
    processedAt: tz('processed_at').notNull().defaultNow(),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'pk_inbox', columns: [t.id] }),
    unique('uq_inbox_message_handler').on(t.messageId, t.handler),
  ],
);

export const batchResumeRequests = bulk.table(
  'batch_resume_requests',
  {
    id: uuid('id').defaultRandom().notNull(),
    batchJobId: uuid('batch_job_id').notNull(),
    ownerSub: uuid('owner_sub').notNull(),
    correlationId: uuid('correlation_id').notNull(),
    intentHash: char('intent_hash', { length: 64 }).notNull(),
    acceptedResponse: jsonb('accepted_response')
      .notNull()
      .$type<Record<string, unknown>>(),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'pk_batch_resume_requests', columns: [t.id] }),
    foreignKey({
      name: 'fk_batch_resume_requests_batch_job_id',
      columns: [t.batchJobId],
      foreignColumns: [batchJobs.id],
    }).onDelete('restrict'),
    unique('uq_batch_resume_requests_batch_correlation').on(
      t.batchJobId,
      t.correlationId,
    ),
    check(
      'ck_batch_resume_requests_intent_hash',
      sql`${t.intentHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const retryCommands = bulk.table(
  'retry_commands',
  {
    commandAttemptId: uuid('command_attempt_id').notNull(),
    resumeRequestId: uuid('resume_request_id').notNull(),
    batchJobId: uuid('batch_job_id').notNull(),
    domain: text('domain').notNull(),
    familyKey: text('family_key').notNull(),
    businessOperationId: uuid('business_operation_id').notNull(),
    attemptNumber: integer('attempt_number').notNull(),
    messageId: uuid('message_id').notNull(),
    previousMessageId: uuid('previous_message_id').notNull(),
    payloadHash: char('payload_hash', { length: 64 }).notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'pk_retry_commands', columns: [t.commandAttemptId] }),
    foreignKey({
      name: 'fk_retry_commands_resume_request_id',
      columns: [t.resumeRequestId],
      foreignColumns: [batchResumeRequests.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fk_retry_commands_batch_job_id',
      columns: [t.batchJobId],
      foreignColumns: [batchJobs.id],
    }).onDelete('restrict'),
    unique('uq_retry_commands_message_id').on(t.messageId),
    unique('uq_retry_commands_request_family').on(
      t.resumeRequestId,
      t.familyKey,
    ),
    check('ck_retry_commands_domain', sql`${t.domain} = 'CATALOGO'`),
    check('ck_retry_commands_attempt_number', sql`${t.attemptNumber} >= 2`),
    check(
      'ck_retry_commands_payload_hash',
      sql`${t.payloadHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const domainAttempts = bulk.table(
  'domain_attempts',
  {
    attemptId: uuid('attempt_id').notNull(),
    batchRowId: uuid('batch_row_id').notNull(),
    domain: text('domain').notNull(),
    businessOperationId: uuid('business_operation_id').notNull(),
    attemptNumber: integer('attempt_number').notNull(),
    previousAttemptId: uuid('previous_attempt_id'),
    commandAttemptId: uuid('command_attempt_id'),
    status: text('status').notNull(),
    effectState: text('effect_state').notNull(),
    retriable: boolean('retriable').notNull().default(false),
    receiptMessageId: uuid('receipt_message_id'),
    errorCode: text('error_code'),
    createdAt: tz('created_at').notNull().defaultNow(),
    updatedAt: tz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'pk_domain_attempts', columns: [t.attemptId] }),
    foreignKey({
      name: 'fk_domain_attempts_batch_row_id',
      columns: [t.batchRowId],
      foreignColumns: [batchRows.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fk_domain_attempts_previous_attempt_id',
      columns: [t.previousAttemptId],
      foreignColumns: [t.attemptId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fk_domain_attempts_command_attempt_id',
      columns: [t.commandAttemptId],
      foreignColumns: [retryCommands.commandAttemptId],
    }).onDelete('restrict'),
    unique('uq_domain_attempts_row_domain_number').on(
      t.batchRowId,
      t.domain,
      t.attemptNumber,
    ),
    check('ck_domain_attempts_domain', sql`${t.domain} = 'CATALOGO'`),
    check('ck_domain_attempts_attempt_number', sql`${t.attemptNumber} >= 1`),
    check(
      'ck_domain_attempts_status',
      sql`${t.status} IN ('PENDING','COMPLETED','REJECTED','UNKNOWN')`,
    ),
    check(
      'ck_domain_attempts_effect_state',
      sql`${t.effectState} IN ('NONE','APPLIED','UNKNOWN')`,
    ),
    uniqueIndex('uq_domain_attempts_previous_attempt')
      .on(t.previousAttemptId)
      .where(sql`${t.previousAttemptId} IS NOT NULL`),
  ],
);

export const bulkSchema = {
  fileManifests,
  batchJobs,
  contentDocuments,
  batchRows,
  rowDomainSteps,
  exportJobs,
  outbox,
  outboxDeliveries,
  inbox,
  batchResumeRequests,
  retryCommands,
  domainAttempts,
};
