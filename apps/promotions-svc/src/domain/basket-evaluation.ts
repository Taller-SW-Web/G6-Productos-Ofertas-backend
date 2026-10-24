import { Decimal } from './decimal.js';
import {
  CommercialDependencyError,
  type BasketRequest,
  type ResolvedBasket,
} from './commercial-context.js';
import {
  bestAlternative,
  couponRejection,
  discountFor,
  effectiveAt,
  type BenefitCandidate,
  type CouponRejection,
} from './promotion-rules.js';
import type {
  CouponQueryRow,
  PromotionQueryRow,
} from '../infrastructure/persistence/query-repository.js';
const zero = Decimal.from(0);
export function evaluateBasket(
  request: BasketRequest,
  context: ResolvedBasket,
  promotions: readonly PromotionQueryRow[],
  coupon: (CouponQueryRow & { customerUsed: number }) | undefined,
  at: string,
) {
  if (context.lines.length !== request.lines.length || !context.lines.length)
    throw new CommercialDependencyError(
      'evaluación',
      'Catálogo/Pricing',
      'cesta completa y coherente con las identidades solicitadas',
    );
  const lines = context.lines.map((line, index) => {
    const input = request.lines[index];
    if (
      line.sku !== input.sku ||
      line.quantity !== input.quantity ||
      (input.product_id != null && input.product_id !== line.productId) ||
      !line.active ||
      !line.channelEligible ||
      !line.productId
    )
      throw new CommercialDependencyError(
        'elegibilidad',
        'Catálogo',
        'identidad SKU/producto y elegibilidad verificadas para el canal',
      );
    const regular = Decimal.from(line.regular);
    const offer = line.offer === null ? regular : Decimal.from(line.offer);
    if (
      regular.compare(zero) <= 0 ||
      offer.compare(zero) <= 0 ||
      offer.compare(regular) > 0
    )
      throw new CommercialDependencyError(
        'precio',
        'Pricing',
        'precio regular/oferta vigente y coherente',
      );
    return {
      ...line,
      regular: regular.multiply(Decimal.from(line.quantity)),
      offer: offer.multiply(Decimal.from(line.quantity)),
    };
  });
  const currency = lines[0].currency;
  if (!currency || lines.some((l) => l.currency !== currency))
    throw new CommercialDependencyError(
      'moneda',
      'Pricing',
      'moneda única conocida para evaluar la cesta',
    );
  const original = lines.reduce((v, l) => v.add(l.regular), zero);
  const priced = lines.reduce((v, l) => v.add(l.offer), zero);
  const alternatives: BenefitCandidate[] = [
    {
      id: '',
      priority: Number.MAX_SAFE_INTEGER,
      usesCoupon: false,
      resultAmount: priced,
      policy: { pricingOffer: false, automaticPromotion: false, coupon: false },
    },
  ];
  let rejection: CouponRejection | undefined =
    request.coupon_code && !coupon ? 'CUPON_NO_ENCONTRADO' : undefined;
  const eligible: BenefitCandidate[] = [];
  for (const p of promotions) {
    const scoped = lines.filter((l) =>
      p.scopes.some((s) => s.sku === l.sku || s.productId === l.productId),
    );
    const applicable =
      p.state === 'ACTIVO' &&
      effectiveAt(p.validFrom, p.validUntil, at) &&
      p.enabledChannels.includes(request.channel_id) &&
      scoped.length > 0;
    const usesCoupon = p.modality === 'CUPON';
    if (usesCoupon) {
      if (!coupon || coupon.promotionId !== p.id || !request.coupon_code)
        continue;
      rejection = couponRejection(
        {
          ...coupon,
          promotionState: p.state,
          validFrom: p.validFrom,
          validUntil: p.validUntil,
          eligible: applicable,
        },
        original,
        at,
        request.customer_ref,
      );
      if (rejection) continue;
    } else if (!applicable) continue;
    if (!p.policy) throw new Error('INCOMPLETE_PROMOTION_POLICY');
    const base = p.policy.pricingOffer ? priced : original;
    const subtotal = scoped.reduce(
      (v, l) => v.add(p.policy!.pricingOffer ? l.offer : l.regular),
      zero,
    );
    const candidate = {
      id: p.id,
      priority: p.priority,
      usesCoupon,
      resultAmount: base.subtract(
        discountFor(subtotal, p.discountType, p.discountValue),
      ),
      policy: {
        pricingOffer: p.policy.pricingOffer,
        automaticPromotion: p.policy.automaticPromotion,
        coupon: p.policy.coupon,
      },
    };
    eligible.push(candidate);
    alternatives.push(candidate);
  }
  // No implicit stacking formula or ambiguous primary promotion_id is published.
  // Single/exclusive alternatives are fully defined; multi-benefit composition
  // needs an explicit G6 decision consistent with the aggregate response schema.
  for (let i = 0; i < eligible.length; i++)
    for (let j = i + 1; j < eligible.length; j++) {
      const a = eligible[i],
        b = eligible[j];
      if (
        (b.usesCoupon ? a.policy.coupon : a.policy.automaticPromotion) &&
        (a.usesCoupon ? b.policy.coupon : b.policy.automaticPromotion)
      )
        throw new CommercialDependencyError(
          'composición de beneficios',
          'Promotions/arquitectura G6',
          'fórmula de acumulación y representación promotion_id aprobadas para combinaciones múltiples',
        );
    }
  const winner = bestAlternative(alternatives)!;
  return {
    original,
    discount: original.subtract(winner.resultAmount),
    result: winner.resultAmount,
    currency,
    promotionId: winner.id || null,
    couponRejection: rejection,
    couponApplicable:
      !!coupon && !rejection && eligible.some((c) => c.usesCoupon),
    couponCandidate: eligible.find((c) => c.usesCoupon),
    winner,
  };
}
