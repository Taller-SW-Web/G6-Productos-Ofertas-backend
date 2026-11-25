import test from 'node:test';
import assert from 'node:assert/strict';
import { allowEvidenceFields, assertSafeEvidenceText } from './evidence-security.mjs';

test('H5 accepts only allowlisted synthetic evidence fields', () => {
  assert.deepEqual(allowEvidenceFields({ schema_version: 1, scenario_id: 'INT01-001', status: 'PASS', title: 'discarded' }), {
    schema_version: 1,
    scenario_id: 'INT01-001',
    status: 'PASS',
  });
});

test('H5 rejects credential, private endpoint and personal-data canaries', () => {
  for (const value of [
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.signaturetoken',
    'Authorization: Bearer synthetic-canary',
    'Cookie: session=synthetic-canary',
    'password=synthetic-canary',
    'postgresql://synthetic:canary@localhost/test',
    'https://private-m2m.invalid/synthetic',
    'base64: c3ludGhldGljLWNhbmFyeQ==',
    'synthetic.person@example.invalid',
  ]) assert.throws(() => assertSafeEvidenceText(value), /EVIDENCE_REJECTED/);
});
