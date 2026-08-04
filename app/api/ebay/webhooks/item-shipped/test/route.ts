import { NextResponse } from 'next/server';
import { getValidToken } from '@/app/lib/ebay-auth';
import { findExistingDestination, findExistingSubscription } from '@/app/lib/ebay-notification';
import { ebayApiRoot } from '@/app/lib/ebay-app-token';

// -----------------------------------------------------------------------
// Asks eBay to push a mock ITEM_MARKED_SHIPPED notification to the live
// webhook — validates delivery, auth-bypass, and signature verification
// end-to-end without waiting for a real shipment. The mock payload uses
// sample data (not a real order), so it won't produce a real packing slip
// — expect the webhook to log "no ebay_sales rows found" and skip slip
// generation, which is fine; that means the pipeline ran correctly up to
// the point where it needs real order data.
//
// To preview actual packing slip PDF output/rotation against a real past
// order instead, use GET /api/ebay/packing-slip/{orderNumber}.
//
// POST /api/ebay/webhooks/item-shipped/test — no body needed.
// -----------------------------------------------------------------------

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export async function POST() {
  try {
    const endpoint = requireEnv('EBAY_WEBHOOK_URL');
    const token = await getValidToken();

    const destinationId = await findExistingDestination(token, endpoint);
    if (!destinationId) {
      return NextResponse.json(
        { error: 'No destination registered yet — run POST /api/ebay/webhooks/item-shipped/setup first.' },
        { status: 400 }
      );
    }

    const subscriptionId = await findExistingSubscription(token, destinationId);
    if (!subscriptionId) {
      return NextResponse.json(
        { error: 'No subscription registered yet — run POST /api/ebay/webhooks/item-shipped/setup first.' },
        { status: 400 }
      );
    }

    const res = await fetch(`${ebayApiRoot()}/commerce/notification/v1/subscription/${subscriptionId}/test`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`testSubscription failed: ${res.status} ${text}`);
    }
    const data = await res.json();

    return NextResponse.json({
      ok: true,
      subscriptionId,
      ...data,
      note: 'eBay is delivering a mock payload to the webhook now — check Vercel logs for [item-shipped webhook] entries within a few seconds.',
    });
  } catch (err: any) {
    console.error('[item-shipped webhook test] failed:', err.message || err);
    return NextResponse.json({ error: err.message || 'Test trigger failed' }, { status: 500 });
  }
}
