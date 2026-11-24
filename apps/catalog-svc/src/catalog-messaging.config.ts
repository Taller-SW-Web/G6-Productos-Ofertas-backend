export const catalogH5DestinationNames = [
  'g6.pricing.from.catalog',
  'g6.inventory.from.catalog',
  'g6.promotions.from.catalog',
  'g6.combos.from.catalog',
  'g6.taxonomy.from.catalog',
  'g6.bulk.from.catalog',
] as const;

export type CatalogH5Destination = (typeof catalogH5DestinationNames)[number];
export type CatalogMessagingProvider = 'RABBITMQ' | 'AZURE_SERVICE_BUS';

export function readCatalogMessagingProvider(
  env: Readonly<Record<string, string | undefined>>,
): CatalogMessagingProvider {
  const provider = env.MESSAGING_PROVIDER;
  if (provider === undefined || provider === 'RABBITMQ') return 'RABBITMQ';
  if (provider === 'AZURE_SERVICE_BUS') return provider;
  throw new Error('MESSAGING_PROVIDER debe ser RABBITMQ o AZURE_SERVICE_BUS.');
}

export function readCatalogH5Destinations(
  env: Readonly<Record<string, string | undefined>>,
): readonly CatalogH5Destination[] {
  const value = env.CATALOG_H5_DESTINATIONS ?? '';
  if (!value.trim()) return [];
  const destinations = value.split(',').map((entry) => entry.trim());
  const allowed = new Set<string>(catalogH5DestinationNames);
  if (
    destinations.some((destination) => !allowed.has(destination)) ||
    new Set(destinations).size !== destinations.length
  ) {
    throw new Error(
      'CATALOG_H5_DESTINATIONS contiene destinos no autorizados.',
    );
  }
  return destinations as CatalogH5Destination[];
}
