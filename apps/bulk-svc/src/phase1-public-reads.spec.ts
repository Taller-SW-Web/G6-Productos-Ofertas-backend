import {
  PHASE1_PUBLIC_READS,
  isPhase1PublicRead,
} from './phase1-public-reads.js';

describe('Retired Phase 1 public read selection under G7-only (bulk-svc)', () => {
  for (const route of PHASE1_PUBLIC_READS) {
    const path = route.path.replace(/[{][^}]+[}]/g, 'fixture');
    const request = { method: route.method, path, headers: {} };
    it(
      route.operationId + ': never allows anonymous bypass in any mode',
      () => {
        const enabled = [route.operationId];
        for (const phase of [
          undefined,
          'PUBLIC_READ_ONLY',
          'SIMULATED_AUTH',
          'G7_AUTHENTICATED',
        ]) {
          expect(isPhase1PublicRead(request, phase, enabled)).toBe(false);
          expect(isPhase1PublicRead(request, phase, [])).toBe(false);
        }
        expect(
          isPhase1PublicRead(
            { ...request, headers: { authorization: 'Bearer invalid' } },
            'PUBLIC_READ_ONLY',
            enabled,
          ),
        ).toBe(false);
      },
    );
  }
});
