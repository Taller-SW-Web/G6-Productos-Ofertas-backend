import test from 'node:test';
import assert from 'node:assert/strict';
import { assertLiveAllowed, redactUrl, sha256 } from './common.mjs';

test('live execution is denied unless every explicit gate and allowlist is present', () => {
  const old = { approval: process.env.H5_LIVE_APPROVED, identity: process.env.H5_TEST_IDENTITY, allow: process.env.H5_DESTINATION_ALLOWLIST };
  try {
    delete process.env.H5_LIVE_APPROVED; delete process.env.H5_TEST_IDENTITY; delete process.env.H5_DESTINATION_ALLOWLIST;
    assert.throws(() => assertLiveAllowed('https://example.invalid/path', 'APIM_EDGE_URL'), /BLOCKED_APPROVAL/);
    process.env.H5_LIVE_APPROVED = 'true';
    assert.throws(() => assertLiveAllowed('https://example.invalid/path', 'APIM_EDGE_URL'), /BLOCKED_IDENTITY/);
    process.env.H5_TEST_IDENTITY = 'true';
    assert.throws(() => assertLiveAllowed('https://example.invalid/path', 'APIM_EDGE_URL'), /BLOCKED_ALLOWLIST/);
    process.env.H5_DESTINATION_ALLOWLIST = 'example.invalid';
    assert.throws(() => assertLiveAllowed('https://example.invalid/path', 'APIM_EDGE_URL'), /BLOCKED_ALLOWLIST/);
    process.env.H5_DESTINATION_ALLOWLIST = 'https://edge.example.invalid';
    assert.equal(assertLiveAllowed('https://edge.example.invalid/x', 'APIM_EDGE_URL').hostname, 'edge.example.invalid');
  } finally {
    for (const [key, value] of Object.entries({ H5_LIVE_APPROVED: old.approval, H5_TEST_IDENTITY: old.identity, H5_DESTINATION_ALLOWLIST: old.allow })) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});

test('output URI redaction omits query and fragment and hashing is byte based', () => {
  assert.equal(redactUrl('https://edge.example.invalid/api?sig=secret#x'), 'https://[host-redacted]/api');
  assert.equal(sha256(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
