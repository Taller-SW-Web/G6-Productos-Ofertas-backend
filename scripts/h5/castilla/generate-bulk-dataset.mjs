#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const args = Object.fromEntries(process.argv.slice(2).filter((x) => x.startsWith('--')).map((x, i, a) => [x.slice(2), a[i + 1]]));
const rows = Number(args.rows ?? 100);
const seed = args.seed ?? 'h5-castilla-v1';
const uniquePlaceholder = args['unique-placeholder'] === 'true';
const out = resolve(args.out ?? 'bulk-h5.csv');
const templateSource = readFileSync(resolve(root, 'apps/bulk-svc/src/domain/bulk-template-v2.ts'), 'utf8');
const match = templateSource.match(/BULK_TEMPLATE_HEADERS\s*=\s*\[([\s\S]*?)\]/);
if (!match) throw new Error('Could not locate BULK_TEMPLATE_HEADERS in current source');
const headers = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
if (!headers.length) throw new Error('Template header list is empty');
if (![100, 1000, 5000].includes(rows)) throw new Error('--rows must be 100, 1000, or 5000');
const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
const csvRows = [headers.map(quote).join(',')];
for (let index = 1; index <= rows; index += 1) {
  const record = Object.fromEntries(headers.map((header) => [header, '']));
  const put = (name, value) => { if (Object.hasOwn(record, name)) record[name] = value; };
  put('operacion', 'ALTA');
  put('sku_base', `H5-${seed.replace(/[^A-Za-z0-9]/g, '').slice(0, 8)}-${uniquePlaceholder ? '{{VU0000}}-{{ITER000000}}-' : ''}${String(index).padStart(5, '0')}`);
  put('sku_variante', `H5V-${String(index).padStart(5, '0')}`);
  put('nombre', `Producto H5 sintetico ${index}`);
  put('descripcion', `Dataset determinista ${seed}`);
  put('categoria_id', 'cat-1');
  put('marca_id', 'marca-1');
  put('tipo_producto_id', 'tipo-1');
  put('tiene_variantes', 'false');
  put('precio_regular', '10.50');
  put('atributos_producto', '[]');
  put('stock_inicial', '0');
  csvRows.push(headers.map((key) => quote(record[key])).join(','));
}
const bytes = Buffer.from(`${csvRows.join('\r\n')}\r\n`, 'utf8');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, bytes, { flag: 'wx' });
const manifest = { schema: 'h5-bulk-dataset/v1', format: 'CSV', rows, seed, unique_placeholder: uniquePlaceholder, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), template_headers: headers, generated_by: 'scripts/h5/castilla/generate-bulk-dataset.mjs', destination: out };
writeFileSync(`${out}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
process.stdout.write(`${JSON.stringify({ rows, seed, bytes: bytes.length, sha256: manifest.sha256, manifest: `${out}.manifest.json` })}\n`);
