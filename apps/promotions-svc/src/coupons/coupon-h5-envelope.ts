import { canonicalJson, type CouponCommand } from './coupon-command.js';

// Leave room for AMQP framing and properties under the Basic limit of 256 KiB.
export const couponH5EnvelopeLimit = 240 * 1024;

export function encodeCouponH5Envelope(command: CouponCommand): Buffer {
  return Buffer.from(canonicalJson({ ...command, producer: 'promotions-svc' }));
}

export function validateCouponH5EnvelopeSize(command: CouponCommand): void {
  if (encodeCouponH5Envelope(command).length > couponH5EnvelopeLimit)
    throw new Error('VALIDACION');
}
