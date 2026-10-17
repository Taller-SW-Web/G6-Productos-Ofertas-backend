/** Temporary internal G6 catalogue presentation, explicitly approved by the owner.
 * This does not grant commercial eligibility, invent a principal or permit writes.
 */
export const CATALOG_READ_DEMO = Symbol('CATALOG_READ_DEMO');
export interface CatalogReadDemo {
  readonly enabled: boolean;
}

/** Existing legacy placeholders are not photographs of the stored product. */
export function isDemoCatalogImage(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      url.hostname !== 'placehold.co'
    );
  } catch {
    return false;
  }
}

export function readCatalogReadDemo(
  env: Record<string, string | undefined> = process.env,
): CatalogReadDemo {
  const flag = env.G6_READ_ONLY_DEMO_ENABLED ?? 'false';
  if (!['true', 'false'].includes(flag))
    throw new Error('G6_READ_ONLY_DEMO_ENABLED debe ser true/false.');
  return Object.freeze({ enabled: flag === 'true' });
}
