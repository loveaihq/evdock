// Standard Webhooks symmetric signatures, as profiled by the MCP Events draft
// (docs/spec/design-sketch-2026-10-06.md, "Signature scheme").

import { createHmac, timingSafeEqual } from 'node:crypto';

const SECRET_PREFIX = 'whsec_';
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Decodes a `whsec_` secret into key bytes. Throws unless it is base64 of 24–64 bytes. */
export function decodeSecret(secret: string): Buffer {
  if (!secret.startsWith(SECRET_PREFIX)) throw new Error('secret must start with whsec_');
  const encoded = secret.slice(SECRET_PREFIX.length);
  if (encoded.length % 4 !== 0 || !BASE64.test(encoded)) throw new Error('secret is not valid base64');
  const key = Buffer.from(encoded, 'base64');
  if (key.length < 24 || key.length > 64) throw new Error('secret must decode to 24-64 bytes');
  return key;
}

/** Base64 HMAC-SHA256 over `id.timestamp.` (UTF-8) followed by the raw body bytes. */
export function computeSignature(key: Buffer, webhookId: string, timestamp: string, body: Buffer): string {
  return createHmac('sha256', key)
    .update(`${webhookId}.${timestamp}.`, 'utf8')
    .update(body)
    .digest('base64');
}

/**
 * Checks a `webhook-signature` header: space-delimited `version,signature` entries.
 * Accepts if any `v1,` entry matches; other versions (e.g. `v1a,`) are ignored.
 */
export function verifySignature(
  key: Buffer,
  webhookId: string,
  timestamp: string,
  body: Buffer,
  header: string,
): boolean {
  const expected = Buffer.from(computeSignature(key, webhookId, timestamp, body));
  for (const entry of header.split(' ')) {
    if (!entry.startsWith('v1,')) continue;
    const candidate = Buffer.from(entry.slice(3));
    // Length is public (always 44 for SHA-256); only the content comparison must be constant-time.
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) return true;
  }
  return false;
}
