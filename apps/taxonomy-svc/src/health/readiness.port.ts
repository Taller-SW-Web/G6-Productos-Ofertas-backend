export const TAXONOMY_READINESS = 'TAXONOMY_READINESS';

export interface TaxonomyReadinessIndicator {
  verificarReadiness(): Promise<void>;
}
