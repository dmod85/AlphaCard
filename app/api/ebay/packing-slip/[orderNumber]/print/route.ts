import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabase-admin';

export const runtime = 'nodejs';

// POST /api/ebay/packing-slip/{orderNumber}/print
// Queues a Canon print. The site stays on alphacard.vercel.app; the print
// agent on the packing PC picks this up and prints portrait letter at actual size.
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
        notification_id: `slip-print:${orderNumber}:${Date.now()}`,
        topic: 'PACKING_SLIP_PRINT',
        order_number: orderNumber,
    });
    if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 });
    return NextResponse.json({ ok: true });
}
