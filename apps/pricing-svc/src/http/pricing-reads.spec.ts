import { wireVersion } from './pricing-reads.js';

describe('Versiones en JSON contractual', () => {
  it('nunca redondea una versión bigint que el cliente no pueda reenviar exactamente', () => {
    expect(wireVersion(1n)).toBe(1);
    expect(wireVersion(BigInt(Number.MAX_SAFE_INTEGER))).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    for (const value of [0n, BigInt(Number.MAX_SAFE_INTEGER) + 1n])
      expect(() => wireVersion(value)).toThrow('ERROR_INTERNO');
  });
});
