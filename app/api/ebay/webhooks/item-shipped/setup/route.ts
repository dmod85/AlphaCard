import { NextResponse } from 'next/server';
import { getValidToken } from '@/app/lib/ebay-auth';
import {
  TOPIC_ID,
  ensureAlertConfig,
  findExistingDestination,
  createDestination,
  getTopicSchemaVersion,
  findExistingSubscription,
  createSubscription,
} from '@/app/lib/ebay-notification';

// -----------------------------------------------------------------------
// One-time (idempotent) setup for the ITEM_MARKED_SHIPPED webhook.
// Run this once after deploying — POST /api/ebay/webhooks/item-shipped/setup
// (no body needed). Registers (or reuses) an eBay Notification API
// destination pointed at EBAY_WEBHOOK_URL, and subscribes it to
// ITEM_MARKED_SHIPPED. eBay will immediately GET EBAY_WEBHOOK_URL with a
// challenge_code to verify ownership — that must resolve (i.e. this app
// must already be deployed and reachable) before this call will succeed.
//
// Requires the seller to have re-authorized at /ebay-connect after
// commerce.notification.subscription + commerce.shipping were added to
// EBAY_SCOPES in ebay-auth.ts (ITEM_MARKED_SHIPPED is a USER-scoped topic).
// -----------------------------------------------------------------------

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export async function POST() {
  try {
    const endpoint = requireEnv('EBAY_WEBHOOK_URL');
    const verificationToken = requireEnv('EBAY_WEBHOOK_VERIFICATION_TOKEN');
    const token = await getValidToken();

    await ensureAlertConfig(token);

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
