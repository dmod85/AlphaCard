import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabase-admin';
import { generatePackingSlipPdf, PackingSlipOrder } from '@/app/lib/packing-slip';

// Manual/on-demand packing slip generation — GET /api/ebay/packing-slip/{orderNumber}
// Reuses the same generator the ITEM_MARKED_SHIPPED webhook uses, useful for
// testing the layout or re-printing without waiting for a real eBay event.

export const runtime = 'nodejs';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orderNumber: string }> }
) {
  const { orderNumber } = await params;

  const { data: rows, error } = await supabaseAdmin
    .from('ebay_sales')
    .select('*')
    .eq('order_number', orderNumber);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!rows || rows.length === 0) {
    return NextResponse.json({ error: `No sales found for order ${orderNumber}` }, { status: 404 });
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

  return new NextResponse(Buffer.from(pdfBytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="packing-slip-${orderNumber}.pdf"`,
    },
  });
}
