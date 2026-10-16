import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const contract = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const names = [
  'PromotionsCouponConsumptionRequested',
  'PromotionsCouponRestorationRequested',
  'PromotionsCouponConsumptionCompleted',
  'PromotionsCouponConsumptionRejected',
  'PromotionsCouponRestorationCompleted',
  'PromotionsCouponRestorationRejected',
];
function dereference(value) {
  if (Array.isArray(value)) return value.map(dereference);
  if (value === null || typeof value !== 'object') return value;
  if (value.$ref) {
    if (!value.$ref.startsWith('#/components/schemas/'))
      throw new Error('UNEXPECTED_REFERENCE');
    return dereference(
      contract.components.schemas[value.$ref.split('/').at(-1)],
    );
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, dereference(item)]),
  );
}
const messages = Object.fromEntries(
  names.map((name) => {
    const message = contract.components.messages[name];
    return [
      message.name,
      {
        exchange: message['x-exchange'],
        routingKey: message['x-routing-key'],
        schema: dereference(message.payload),
      },
    ];
  }),
);
writeFileSync(
  fileURLToPath(
    new URL('../src/coupons/coupon-contract.generated.ts', import.meta.url),
  ),
  '// Generated from G6 Docs c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b, AsyncAPI 0.6.0-rc.2.\n' +
    "import type { MessageContract } from './schema-validator.js';\n" +
    'export const couponContracts: Readonly<Record<string, MessageContract>> = ' +
    JSON.stringify(messages, null, 2) +
    ';\n',
);
