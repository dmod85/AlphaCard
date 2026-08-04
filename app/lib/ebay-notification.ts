import 'server-only';
import { ebayApiRoot } from './ebay-app-token';

// Shared helpers for eBay's Commerce Notification API (destination /
// subscription / config management). Used by the item-shipped webhook's
// setup and test-trigger routes.
//
// ITEM_MARKED_SHIPPED is a USER-scoped topic (per getTopic's "scope":
// "USER", requiring the commerce.shipping authorization scope) — not an
// application-scoped one — so all calls here must run with the seller's
// own OAuth user token (from ebay-auth.ts), not a client_credentials app
// token.

export const TOPIC_ID = 'ITEM_MARKED_SHIPPED';

export async function ebayFetch(path: string, token: string, init?: RequestInit) {
  return fetch(`${ebayApiRoot()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
}

// The Notification API refuses ALL destination/subscription calls — even
// read-only ones — with a generic 195003 "Please provide configurations
// required for notifications" until an account-level alert config exists.
// This is undocumented on the createDestination/createSubscription pages
// themselves; it only turns up on the separate config resource's docs.
export async function ensureAlertConfig(token: string): Promise<void> {
  const getRes = await ebayFetch('/commerce/notification/v1/config', token);
  if (getRes.ok) return; // already configured

  const alertEmail = process.env.STORE_ALERT_EMAIL?.trim() || 'dmod85@gmail.com';
  const putRes = await ebayFetch('/commerce/notification/v1/config', token, {
    method: 'PUT',
    body: JSON.stringify({ alertEmail }),
  });
  if (!putRes.ok) {
    const text = await putRes.text();
    throw new Error(`updateConfig failed: ${putRes.status} ${text}`);
  }
}

export async function findExistingDestination(token: string, endpoint: string): Promise<string | null> {
  const res = await ebayFetch('/commerce/notification/v1/destination?limit=100', token);
  if (!res.ok) return null;
  const data = (await res.json()) as { destinations?: Array<{ destinationId: string; deliveryConfig: { endpoint: string } }> };
  const match = data.destinations?.find((d) => d.deliveryConfig?.endpoint === endpoint);
  return match?.destinationId ?? null;
}

export async function createDestination(token: string, endpoint: string, verificationToken: string): Promise<string> {
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

export async function getTopicSchemaVersion(token: string): Promise<string> {
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

export async function findExistingSubscription(token: string, destinationId: string): Promise<string | null> {
  const res = await ebayFetch('/commerce/notification/v1/subscription?limit=100', token);
  if (!res.ok) return null;
  const data = (await res.json()) as { subscriptions?: Array<{ subscriptionId: string; topicId: string; destinationId: string; status: string }> };
  const match = data.subscriptions?.find((s) => s.topicId === TOPIC_ID && s.destinationId === destinationId);
  return match?.subscriptionId ?? null;
}

export async function createSubscription(token: string, destinationId: string, schemaVersion: string): Promise<string> {
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
