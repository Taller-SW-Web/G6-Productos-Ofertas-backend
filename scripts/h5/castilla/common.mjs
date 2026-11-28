import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
export const redactUrl = (value) => {
  const url = new URL(value);
  return `${url.protocol}//[host-redacted]${url.pathname}`;
};
export function assertLiveAllowed(url, variableName) {
  if (process.env.H5_LIVE_APPROVED !== 'true') throw new Error('BLOCKED_APPROVAL: H5_LIVE_APPROVED=true is required');
  if (process.env.H5_TEST_IDENTITY !== 'true') throw new Error('BLOCKED_IDENTITY: a dedicated test identity must be declared');
  const allow = (process.env.H5_DESTINATION_ALLOWLIST ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const target = new URL(url);
  if (target.username || target.password || target.search || target.hash) throw new Error('BLOCKED_URL: credentials, query and fragment are not accepted in destination URLs');
  if (!allow.some((entry) => target.origin === entry)) throw new Error('BLOCKED_ALLOWLIST: exact HTTPS origin is not allowlisted');
  if (variableName === 'PRIVATE_CONTROL_URL' && process.env.H5_PRIVATE_CONTROL_AUTHORIZED !== 'true') throw new Error('BLOCKED_PRIVATE_CONTROL: private control route is not approved');
  if (['localhost', '127.0.0.1', '::1'].includes(target.hostname) && process.env.H5_ALLOW_LOOPBACK !== 'true') throw new Error('BLOCKED_LOOPBACK: loopback requires explicit authorization');
  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && process.env.H5_ALLOW_LOOPBACK === 'true' && ['localhost', '127.0.0.1', '::1'].includes(target.hostname))) throw new Error('BLOCKED_TLS: live targets must use HTTPS');
  return target;
}
export async function readJsonLimited(response, maxBytes = 1024 * 1024) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Response body is unavailable');
  const chunks = []; let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); throw new Error('Response exceeded the 1 MiB harness limit'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
}
export async function readBytesLimited(response, maxBytes = 1024 * 1024) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Response body is unavailable');
  const chunks = []; let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); throw new Error('Response exceeded the 1 MiB harness limit'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, bytes);
}
export async function request(url, options = {}) {
  const timeoutMs = Number(process.env.H5_REQUEST_TIMEOUT_MS ?? 8000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw new Error('timeout must be 100..30000ms');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, redirect: 'manual', signal: controller.signal }); }
  finally { clearTimeout(timer); }
}
