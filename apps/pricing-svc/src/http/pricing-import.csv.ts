import { cents, PriceRuleError, requireRule } from '../domain/price.js';
import { PricingHttpError } from './pricing-http.error.js';
import { parsePriceUpdateRequest } from './pricing-write.dto.js';

export const PRICE_IMPORT_MAX_BYTES = 1024 * 1024;
const header = [
  'sku',
  'channelId',
  'priceVersion',
  'precioRegular',
  'accionPrecioOferta',
  'precioOferta',
  'moneda',
  'motivoCambio',
];

export function importUpdate(row: Record<string, unknown>) {
  const version = row.priceVersion;
  requireRule(
    typeof version === 'string' && /^[1-9]\d{0,15}$/.test(version),
    'VALIDACION',
  );
  return parsePriceUpdateRequest(
    {
      ...row,
      channelId: row.channelId === '' ? null : row.channelId,
      priceVersion: Number(version),
      precioRegular: row.precioRegular === '' ? undefined : row.precioRegular,
      precioOferta: row.precioOferta === '' ? null : row.precioOferta,
    },
    (value) => {
      requireRule(typeof value === 'string', 'PRECIO_INVALIDO');
      cents(value);
      return value;
    },
  );
}

export function parsePriceImport(file: Buffer) {
  if (file.length > PRICE_IMPORT_MAX_BYTES)
    throw new PricingHttpError(413, 'ARCHIVO_EXCEDE_LIMITE');
  let csv: string;
  try {
    csv = new TextDecoder('utf-8', { fatal: true }).decode(file);
  } catch {
    throw new PricingHttpError(400, 'ARCHIVO_INVALIDO');
  }
  if (!csv || csv.includes('\0'))
    throw new PricingHttpError(400, 'ARCHIVO_INVALIDO');
  const unquoted = /[^",\r\n]*/y;
  const records: string[][] = [];
  let offset = 0;
  while (offset < csv.length) {
    const row: string[] = [];
    for (;;) {
      if (csv[offset] === '"') {
        const start = offset + 1;
        let end = csv.indexOf('"', start);
        while (end !== -1 && csv[end + 1] === '"')
          end = csv.indexOf('"', end + 2);
        if (end === -1) throw new PricingHttpError(400, 'ARCHIVO_INVALIDO');
        row.push(csv.slice(start, end).replaceAll('""', '"'));
        offset = end + 1;
      } else {
        unquoted.lastIndex = offset;
        row.push(unquoted.exec(csv)![0]);
        offset = unquoted.lastIndex;
      }
      const delimiter = csv[offset];
      if (delimiter === ',') {
        offset++;
        continue;
      }
      if (delimiter === '\r' && csv[offset + 1] === '\n') offset += 2;
      else if (delimiter === '\n') offset++;
      else if (delimiter !== undefined)
        throw new PricingHttpError(400, 'ARCHIVO_INVALIDO');
      break;
    }
    records.push(row);
    if (records.length > 1001)
      throw new PricingHttpError(413, 'ARCHIVO_EXCEDE_LIMITE');
  }
  const first = records.shift()!;
  if (
    first.length !== header.length ||
    header.some((key, index) => key !== first[index])
  )
    throw new PricingHttpError(422, 'PLANTILLA_INCOMPATIBLE');
  if (!records.length) throw new PricingHttpError(400, 'ARCHIVO_INVALIDO');

  const targets = new Map<string, number>();
  for (const [sku, channel] of records) {
    if (!sku || channel === undefined) continue;
    const key = JSON.stringify([sku, channel]);
    targets.set(key, (targets.get(key) ?? 0) + 1);
  }
  return records.map((fields, index) => {
    const rowInput = Object.fromEntries(
      header.map((key, i) => [key, fields[i] ?? '']),
    );
    const sku =
      rowInput.sku.trim() && rowInput.sku.length <= 256 ? rowInput.sku : null;
    let code: string | null = null;
    try {
      requireRule(
        fields.length === header.length && sku !== null,
        'VALIDACION',
      );
      requireRule(
        targets.get(JSON.stringify([sku, rowInput.channelId])) === 1,
        'VALIDACION',
      );
      importUpdate(rowInput);
    } catch (error) {
      if (!(error instanceof PriceRuleError)) throw error;
      code = error.code;
    }
    return { rowId: String(index + 2), sku, code, rowInput };
  });
}
