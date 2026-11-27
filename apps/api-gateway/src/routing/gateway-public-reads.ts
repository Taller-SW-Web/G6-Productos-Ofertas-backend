import type { ContractRoute } from './contract-route.js';

/** Historical Phase 1 public read list retired under universal G7 authentication.
 * No business operation is eligible for unauthenticated access in production.
 */
const publicReadRoutes: readonly (readonly [string, string, string, string])[] =
  [];

export function isEligiblePublicRead(_route: ContractRoute): boolean {
  void publicReadRoutes;
  return false;
}
