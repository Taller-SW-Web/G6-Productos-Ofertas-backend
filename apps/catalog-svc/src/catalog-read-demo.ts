import { PHASE1_PUBLIC_OPERATION_IDS } from './phase1-public-reads.js';

/** Legacy read-only presentation and explicit restricted H4 access selection.
 * Neither policy grants commercial eligibility or fabricates a G7 principal.
 */
export const CATALOG_READ_DEMO = Symbol('CATALOG_READ_DEMO');
export type CatalogSecurityMode = 'SIMULATED_AUTH' | 'G7_AUTHENTICATED';
export interface CatalogReadDemo {
  readonly enabled: boolean;
  readonly restricted?: boolean;
  readonly gatewayIps?: readonly string[];
  readonly securityMode?: CatalogSecurityMode;
  readonly publicOperations?: readonly string[];
}

const CATALOG_ELIGIBLE_PUBLIC_OPERATIONS = PHASE1_PUBLIC_OPERATION_IDS;

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
  const securityModeRaw = env.G6_SECURITY_MODE;
  if (
    securityModeRaw !== undefined &&
    !['SIMULATED_AUTH', 'G7_AUTHENTICATED'].includes(securityModeRaw)
  ) {
    throw new Error(
      'G6_SECURITY_MODE debe ser G7_AUTHENTICATED (o SIMULATED_AUTH en test).',
    );
  }
  if (securityModeRaw === 'SIMULATED_AUTH' && env.NODE_ENV !== 'test') {
    throw new Error('SIMULATED_AUTH solo se permite en NODE_ENV=test.');
  }
  const securityMode =
    (securityModeRaw as CatalogSecurityMode | undefined) ?? 'G7_AUTHENTICATED';
  const publicOperations = (env.CATALOG_PUBLIC_OPERATION_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (publicOperations.length > 0) {
    throw new Error(
      'CATALOG_PUBLIC_OPERATION_IDS está deshabilitado bajo política universal G7.',
    );
  }
  if (
    env.GATEWAY_DEMO_NO_AUTH_ENABLED === 'true' ||
    env.G6_READ_ONLY_DEMO_ENABLED === 'true' ||
    env.CATALOG_MARKETPLACE_DEMO_PREVIEW_ENABLED === 'true'
  )
    throw new Error('Los bypasses de lectura heredados están deshabilitados.');
  return Object.freeze({
    enabled: false,
    securityMode,
    publicOperations: Object.freeze(publicOperations),
  });
}
