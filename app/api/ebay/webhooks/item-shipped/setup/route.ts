import { NextResponse } from 'next/server';
import { ebayApiRoot } from '@/app/lib/ebay-app-token';
import { getValidToken } from '@/app/lib/ebay-auth';

// -----------------------------------------------------------------------
// One-time (idempotent) setup for the ITEM_MARKED_SHIPPED webhook.
// Run this once after deploying — POST /api/ebay/webhooks/item-shipped/setup
// (no body needed). Registers (or reuses) an eBay Notification API
// destination pointed at EBAY_WEBHOOK_URL, and subscribes it to
// ITEM_MARKED_SHIPPED. eBay will immediately GET EBAY_WEBHOOK_URL with a
// challenge_code to verify ownership — that must resolve (i.e. this app
// must already be deployed and reachable) before this call will succeed.
//
// ITEM_MARKED_SHIPPED is a USER-scoped topic (per getTopic's "scope":
// "USER", requiring the commerce.shipping authorization scope) — not an
// application-scoped one — so this must run as the seller's own OAuth
// user token (same one used for order syncing), not a client_credentials
// app token. The seller must have re-authorized at /ebay-connect after
// commerce.notification.subscription + commerce.shipping were added to
// EBAY_SCOPES in ebay-auth.ts, or this will fail with EBAY_AUTH_REQUIRED
// or a scope-related 401/403 from eBay.
// -----------------------------------------------------------------------

const TOPIC_ID = 'ITEM_MARKED_SHIPPED';

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

async function ebayFetch(path: string, token: string, init?: RequestInit) {
  const res = await fetch(`${ebayApiRoot()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  return res;
}

async function findExistingDestination(token: string, endpoint: string): Promise<string | null> {
  const res = await ebayFetch('/commerce/notification/v1/destination?limit=100', token);
  if (!res.ok) return null;
  const data = (await res.json()) as { destinations?: Array<{ destinationId: string; deliveryConfig: { endpoint: string } }> };
  const match = data.destinations?.find((d) => d.deliveryConfig?.endpoint === endpoint);
  return match?.destinationId ?? null;
}

async function createDestination(token: string, endpoint: string, verificationToken: string): Promise<string> {
  const res = await ebayFetch('/commerce/notification/v1/destination', token, {
    method: 'POST',
    body: JSON.stringify({
      name: 'AlphaCard packing slip webhook',
      status: 'ENABLED',
      deliveryConfig: { endpoint, verificationToken },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`createDestination failed: ${res.status} ${text}`);
  }
  const location = res.headers.get('Location') || '';
  const id = location.split('/').filter(Boolean).pop();
  if (!id) throw new Error(`createDestination succeeded but no destinationId in Location header: ${location}`);
  return id;
}

async function getTopicSchemaVersion(token: string): Promise<string> {
  const res = await ebayFetch(`/commerce/notification/v1/topic/${TOPIC_ID}`, token);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`getTopic(${TOPIC_ID}) failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as { supportedPayloads?: Array<{ schemaVersion: string; format: string }> };
  const jsonPayload = data.supportedPayloads?.find((p) => p.format === 'JSON') ?? data.supportedPayloads?.[0];
  if (!jsonPayload) throw new Error(`Topic ${TOPIC_ID} has no supported JSON payload/schemaVersion`);
  return jsonPayload.schemaVersion;
}

async function findExistingSubscription(token: string, destinationId: string): Promise<string | null> {
  const res = await ebayFetch('/commerce/notification/v1/subscription?limit=100', token);
  if (!res.ok) return null;
  const data = (await res.json()) as { subscriptions?: Array<{ subscriptionId: string; topicId: string; destinationId: string; status: string }> };
  const match = data.subscriptions?.find((s) => s.topicId === TOPIC_ID && s.destinationId === destinationId);
  return match?.subscriptionId ?? null;
}

async function createSubscription(token: string, destinationId: string, schemaVersion: string): Promise<string> {
  const res = await ebayFetch('/commerce/notification/v1/subscription', token, {
    method: 'POST',
    body: JSON.stringify({
      topicId: TOPIC_ID,
      status: 'ENABLED',
      destinationId,
      payload: { deliveryProtocol: 'HTTPS', format: 'JSON', schemaVersion },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`createSubscription failed: ${res.status} ${text}`);
  }
  const location = res.headers.get('Location') || '';
  const id = location.split('/').filter(Boolean).pop();
  if (!id) throw new Error(`createSubscription succeeded but no subscriptionId in Location header: ${location}`);
  return id;
}

export async function POST() {
  try {
    const endpoint = requireEnv('EBAY_WEBHOOK_URL');
    const verificationToken = requireEnv('EBAY_WEBHOOK_VERIFICATION_TOKEN');
    const token = await getValidToken();

    let destinationId = await findExistingDestination(token, endpoint);
    let destinationReused = true;
    if (!destinationId) {
      destinationId = await createDestination(token, endpoint, verificationToken);
      destinationReused = false;
    }

    const schemaVersion = await getTopicSchemaVersion(token);

    let subscriptionId = await findExistingSubscription(token, destinationId);
    let subscriptionReused = true;
    if (!subscriptionId) {
      subscriptionId = await createSubscription(token, destinationId, schemaVersion);
      subscriptionReused = false;
    }

    return NextResponse.json({
      ok: true,
      destinationId,
      destinationReused,
      subscriptionId,
      subscriptionReused,
      topicId: TOPIC_ID,
      schemaVersion,
    });
  } catch (err: any) {
    console.error('[item-shipped webhook setup] failed:', err.message || err);
    return NextResponse.json({ error: err.message || 'Setup failed' }, { status: 500 });
  }
}
