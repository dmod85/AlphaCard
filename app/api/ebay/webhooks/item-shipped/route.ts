import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { supabaseAdmin } from '@/app/lib/supabase-admin';
import { verifyEbayNotificationSignature } from '@/app/lib/ebay-webhook-verify';
import { generatePackingSlipPdf, PackingSlipOrder } from '@/app/lib/packing-slip';
import { fetchAndUpsertOrder } from '@/app/lib/ebay-orders';

// -----------------------------------------------------------------------
// eBay Commerce Notification API webhook — topic ITEM_MARKED_SHIPPED.
//
// eBay doesn't expose a distinct "shipping label purchased" event; buying
// a label through eBay (or entering tracking) is what marks the item
// shipped, which is what actually fires this notification. On receipt we
// generate the packing slip for that order and store it.
//
// GET  — eBay's one-time endpoint-ownership challenge (see setup/route.ts)
// POST — the actual notification delivery
// -----------------------------------------------------------------------

export const runtime = 'nodejs';

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

// ---- GET: challenge-code handshake -------------------------------------
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const challengeCode = searchParams.get('challenge_code');
  if (!challengeCode) {
    return NextResponse.json({ error: 'Missing challenge_code' }, { status: 400 });
  }

  const verificationToken = requireEnv('EBAY_WEBHOOK_VERIFICATION_TOKEN');
  const endpoint = requireEnv('EBAY_WEBHOOK_URL'); // must exactly match the registered destination endpoint

  const hash = crypto.createHash('sha256');
  hash.update(challengeCode);
  hash.update(verificationToken);
  hash.update(endpoint);
  const challengeResponse = hash.digest('hex');

  return NextResponse.json({ challengeResponse }, { status: 200 });
}

// ---- POST: notification delivery ---------------------------------------
interface ItemMarkedShippedData {
  trackingNumber?: string;
  carrier?: string;
  shippedDate?: string;
  orderId?: string;
  itemId?: string;
  transactionId?: string;
  lineItemId?: string;
}

interface NotificationEnvelope {
  topic?: string;
  notification?: {
    notificationId?: string;
    eventDate?: string;
    data?: ItemMarkedShippedData;
  };
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get('x-ebay-signature');

  const verified = await verifyEbayNotificationSignature(rawBody, signature).catch((err) => {
    console.error('[item-shipped webhook] signature verification error:', err);
    return false;
  });
  if (!verified) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 412 });
  }

  let payload: NotificationEnvelope;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const notificationId = payload.notification?.notificationId;
  const data = payload.notification?.data;
  const orderId = data?.orderId;

  if (!notificationId || !orderId) {
    // Ack anyway — eBay retries on non-2xx, and a malformed payload won't fix itself on retry.
    return NextResponse.json({ ok: true, skipped: 'missing notificationId or orderId' });
  }

  // Idempotency guard — eBay may redeliver the same notification.
  const { error: insertErr } = await supabaseAdmin
    .from('ebay_webhook_events')
    .insert({ notification_id: notificationId, topic: payload.topic ?? 'ITEM_MARKED_SHIPPED', order_number: orderId });
  if (insertErr) {
    // Unique violation = already processed this notificationId.
    if (insertErr.code === '23505') {
      return NextResponse.json({ ok: true, skipped: 'duplicate notification' });
    }
    console.error('[item-shipped webhook] failed to record notification event:', insertErr.message);
  }

  try {
    await handleItemMarkedShipped(orderId, data!);
  } catch (err: any) {
    console.error('[item-shipped webhook] processing failed:', err.message || err);
    // Still 200 — we don't want eBay hammering retries for a bug on our side
    // once the notification is durably recorded above.
  }

  return NextResponse.json({ ok: true });
}

async function handleItemMarkedShipped(orderId: string, data: ItemMarkedShippedData) {
  // A label can be bought before this order has ever gone through the
  // periodic sold-orders sync (e.g. shipped within seconds of the sale) —
  // in that case there's no local row to attach tracking/address/slip to,
  // so fetch it fresh from eBay first.
  const { data: existing } = await supabaseAdmin
    .from('ebay_sales')
    .select('id')
    .eq('order_number', orderId)
    .limit(1);
  if (!existing || existing.length === 0) {
    try {
      await fetchAndUpsertOrder(orderId);
    } catch (err: any) {
      console.error(`[item-shipped webhook] failed to fetch order ${orderId} from eBay:`, err.message || err);
    }
  }

  // Persist tracking info on every line item belonging to this order.
  await supabaseAdmin
    .from('ebay_sales')
    .update({
      tracking_number: data.trackingNumber ?? null,
      carrier: data.carrier ?? null,
      shipped_at: data.shippedDate ?? new Date().toISOString(),
    })
    .eq('order_number', orderId);

  const { data: rows, error } = await supabaseAdmin
    .from('ebay_sales')
    .select('*')
    .eq('order_number', orderId);
  if (error) throw error;
  if (!rows || rows.length === 0) {
    console.warn(`[item-shipped webhook] no ebay_sales rows found for order ${orderId} — skipping slip`);
    return;
  }

  const first = rows[0];
  const order: PackingSlipOrder = {
    orderNumber: first.order_number,
    salesRecordNumber: first.sales_record_number,
    saleDate: first.sale_date,
    buyer: first.buyer,
    shipTo: {
      name: first.ship_to_name,
      street1: first.ship_to_street1,
      street2: first.ship_to_street2,
      city: first.ship_to_city,
      state: first.ship_to_state,
      zip: first.ship_to_zip,
      country: first.ship_to_country,
    },
    shippingService: first.shipping_service,
    subtotal: first.order_subtotal,
    shippingCost: first.order_shipping_cost,
    tax: first.order_tax,
    total: first.order_total,
    items: rows.map((r) => ({
      title: r.item_title,
      sku: r.sku,
      ebayItemId: r.ebay_item_id,
      quantity: r.quantity_sold,
      soldFor: r.sold_for,
      pictureUrl: r.picture_url,
    })),
    storeName: process.env.STORE_NAME?.trim() || 'Packing Slip',
    storeUrl: process.env.STORE_URL?.trim() || null,
  };

  const pdfBytes = await generatePackingSlipPdf(order);
  const path = `${orderId}.pdf`;

  const { error: uploadErr } = await supabaseAdmin.storage
    .from('packing-slips')
    .upload(path, Buffer.from(pdfBytes), { contentType: 'application/pdf', upsert: true });
  if (uploadErr) throw uploadErr;

  const { data: publicUrlData } = supabaseAdmin.storage.from('packing-slips').getPublicUrl(path);

  await supabaseAdmin
    .from('ebay_sales')
    .update({
      packing_slip_generated_at: new Date().toISOString(),
      packing_slip_url: publicUrlData.publicUrl,
    })
    .eq('order_number', orderId);
}
