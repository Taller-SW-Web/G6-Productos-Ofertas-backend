import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { Canal } from './commercial.types.js';

export const COMMERCIAL_ELIGIBILITY = Symbol('COMMERCIAL_ELIGIBILITY');
// Puerto interno: la selección debe ser autoritativa, completa y coherente para
// el canal. Se aplica ANTES de COUNT/LIMIT/OFFSET; no filtrar una página ya cortada.
export interface EligibilitySelection {
  productIds: readonly string[];
  variantIds: readonly string[];
}
export interface CommercialEligibilityPolicy {
  resolve(canal: Canal): Promise<EligibilitySelection>;
}
@Injectable()
export class PendingCommercialEligibility implements CommercialEligibilityPolicy {
  async resolve(_canal: Canal): Promise<EligibilitySelection> {
    // D-CAT-05/06: no existe fuente ni default aprobados. ACTIVO no basta.
    throw new ServiceUnavailableException(
      'Servicio temporalmente no disponible',
    );
  }
}
