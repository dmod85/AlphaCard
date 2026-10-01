import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabase-admin';

export const runtime = 'nodejs';

// POST /api/ebay/shipping-label/{orderNumber}/print
export async function POST(
    _request: NextRequest,
    { params }: { params: Promise<{ orderNumber: string }> }
) {
    const { orderNumber } = await params;
    const { data: rows, error } = await supabaseAdmin
        .from('ebay_sales')
        .select('order_number')
        .eq('order_number', orderNumber)
        .limit(1);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!rows || rows.length === 0) {
        return NextResponse.json({ error: `No sales found for order ${orderNumber}` }, { status: 404 });
    }

    const { error: insertErr } = await supabaseAdmin.from('ebay_webhook_events').insert({
        notification_id: `label-print:${orderNumber}:${Date.now()}`,
        topic: 'SHIPPING_LABEL_PRINT',
        order_number: orderNumber,
    });
    if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 });
    return NextResponse.json({ ok: true });
}
