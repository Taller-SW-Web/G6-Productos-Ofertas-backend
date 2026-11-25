#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sha256 } from './common.mjs';

const output = resolve(process.argv[2] ?? 'apps/bulk-svc/test/fixtures/h5-claim-check');
mkdirSync(output, { recursive: true });
const deterministicUuid = (seed) => {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32).split('');
  hex[12] = '5'; hex[16] = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
  const value = hex.join('');
  return `${value.slice(0,8)}-${value.slice(8,12)}-${value.slice(12,16)}-${value.slice(16,20)}-${value.slice(20)}`;
};
const records = [];
for (const kib of [255, 257]) {
  const desiredBytes = kib * 1024;
  const seed = Buffer.from(`{"fixture":"H5-CLAIM-CHECK","size_kib":${kib},"payload":"`);
  const suffix = Buffer.from('"}\n');
  const fill = Buffer.alloc(desiredBytes - seed.length - suffix.length, 0x61);
  const bytes = Buffer.concat([seed, fill, suffix]);
  const path = resolve(output, `claim-check-${kib}kib.json`);
  writeFileSync(path, bytes, { flag: 'wx' });
  records.push({ bytes: bytes.length, filename: path.split(/[\\/]/).at(-1), sha256: sha256(bytes), purpose: kib > 256 ? 'claim-check required; never embed file in Service Bus message' : 'near-limit content reference fixture' });
}
const metadata = { content_id: deterministicUuid('content'), sha256: records[0].sha256, byte_length: records[0].bytes, content_type: 'application/json' };
const envelope = { message_id: deterministicUuid('message'), schema_version: 3, occurred_at: '2026-01-01T00:00:00.000Z', correlation_id: deterministicUuid('correlation'), causation_id: null, operation_id: deterministicUuid('operation'), producer: 'bulk-svc', kind: 'command', name: 'catalog.bulk.upsert.requested', application_properties: { content_type: 'application/json', correlation_id: deterministicUuid('correlation') }, data: { batch_id: deterministicUuid('batch'), batch_operation_id: deterministicUuid('batch-operation'), template_version: 2, mode: 'ALTA', content_ref: metadata } };
const serialized = Buffer.from(JSON.stringify(envelope));
const serviceBusMaxBytes = 256 * 1024;
const envelopeFits = serialized.length <= serviceBusMaxBytes;
const manifest = { schema: 'h5-claim-check-fixtures/v1', synthetic: true, files: records, envelope_serialized_bytes_including_declared_properties: serialized.length, service_bus_max_total_bytes: serviceBusMaxBytes, envelope_fits_preflight_only: envelopeFits, actual_service_bus_wire_size_verified: false, content_reference_only: true, metadata_sha256: createHash('sha256').update(JSON.stringify(metadata)).digest('hex') };
writeFileSync(resolve(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
