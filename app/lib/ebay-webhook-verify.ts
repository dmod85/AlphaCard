import 'server-only';
import crypto from 'crypto';
import { getAppAccessToken, ebayApiRoot } from './ebay-app-token';

/**
 * Verifies the X-EBAY-SIGNATURE header eBay's Notification API attaches to
 * every webhook POST. See:
 * https://developer.ebay.com/api-docs/commerce/notification/overview.html
 *
 * Header value is base64 JSON: { alg, kid, signature, digest }.
 * `kid` looks up a PEM EC public key via GET /commerce/notification/v1/public_key/{kid},
 * which is cached here (eBay asks callers not to fetch it per-notification).
 */

interface SignatureHeader {
  alg: string;
  kid: string;
  signature: string;
  digest: string;
}

const publicKeyCache = new Map<string, { pem: string; expiry: number }>();
const KEY_CACHE_MS = 60 * 60 * 1000; // 1 hour, per eBay's guidance

const KEY_START = '-----BEGIN PUBLIC KEY-----';
const KEY_END = '-----END PUBLIC KEY-----';

// eBay's public_key endpoint returns the PEM markers glued directly to the
// base64 body with no newline (e.g. "-----BEGIN PUBLIC KEY-----MIIB...==-----END
// PUBLIC KEY-----"), which Node's PEM parser rejects — it requires the markers
// on their own line. eBay's own reference SDK does this same normalization:
// https://github.com/eBay/event-notification-nodejs-sdk/blob/main/lib/validator.js
function normalizePublicKeyPem(key: string): string {
  return key
    .replace(KEY_START, `${KEY_START}\n`)
    .replace(KEY_END, `\n${KEY_END}`);
}

async function getPublicKey(kid: string): Promise<string> {
  const cached = publicKeyCache.get(kid);
  if (cached && Date.now() < cached.expiry) return cached.pem;

  const token = await getAppAccessToken();
  const res = await fetch(`${ebayApiRoot()}/commerce/notification/v1/public_key/${kid}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch eBay notification public key: ${res.status}`);
  }
  const data = (await res.json()) as { key: string };
  publicKeyCache.set(kid, { pem: data.key, expiry: Date.now() + KEY_CACHE_MS });
  return data.key;
}

/** rawBody must be the exact bytes eBay POSTed (read via request.text(), not request.json()). */
export async function verifyEbayNotificationSignature(
  rawBody: string,
  signatureHeader: string | null
): Promise<boolean> {
  if (!signatureHeader) return false;

  let parsed: SignatureHeader;
  try {
    parsed = JSON.parse(Buffer.from(signatureHeader, 'base64').toString('utf8'));
  } catch {
    return false;
  }
  if (!parsed.kid || !parsed.signature) return false;

  const publicKeyPem = await getPublicKey(parsed.kid);

  const verifier = crypto.createVerify('SHA1');
  verifier.update(rawBody, 'utf8');
  verifier.end();

  try {
    return verifier.verify(normalizePublicKeyPem(publicKeyPem), Buffer.from(parsed.signature, 'base64'));
  } catch {
    return false;
  }
}
