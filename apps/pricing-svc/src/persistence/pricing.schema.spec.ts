import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  prices,
  priceValidities,
  pricingSchema,
  scheduledPrices,
} from './pricing.schema.js';

describe('Mapping Pricing', () => {
  const db = drizzle.mock({ schema: pricingSchema });

  it('solo declara tablas y FK propias; la unicidad incluye nulos', () => {
    for (const table of Object.values(pricingSchema)) {
      const config = getTableConfig(table);
      expect(config.schema).toBe('pricing');
      for (const fk of config.foreignKeys) {
        expect(getTableConfig(fk.reference().foreignTable).schema).toBe(
          'pricing',
        );
        expect(fk.onDelete).toBe('restrict');
      }
    }
    expect(getTableConfig(prices).uniqueConstraints[0].nullsNotDistinct).toBe(
      true,
    );
  });

  it.each(['0.01', '10', '10.1', '9999999999.99'])(
    'preserva el decimal exacto %s',
    (value) => {
      expect(priceValidities.precioRegular.mapToDriverValue(value)).toBe(value);
      expect(scheduledPrices.importe.mapToDriverValue(value)).toBe(value);
    },
  );

  it.each(['1.001', '10000000000', 'NaN', 'Infinity', '1e2', ''])(
    'rechaza %s antes de redondear en DB',
    (value) => {
      expect(() =>
        priceValidities.precioRegular.mapToDriverValue(value),
      ).toThrow('precisión');
      expect(() => scheduledPrices.importe.mapToDriverValue(value)).toThrow(
        'precisión',
      );
    },
  );

  it('mapea bigint sin pérdida y genera SQL parametrizado y calificado', () => {
    expect(prices.priceVersion.mapFromDriverValue('9007199254740993')).toBe(
      9007199254740993n,
    );
    const query = db
      .insert(prices)
      .values({ productId: 'fixture-sensitive-value' })
      .toSQL();
    expect(query.sql).toContain('"pricing"."prices"');
    expect(query.sql).not.toContain('fixture-sensitive-value');
    expect(query.params).toContain('fixture-sensitive-value');
  });
});
