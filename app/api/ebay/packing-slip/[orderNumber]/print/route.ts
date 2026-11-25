import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabase-admin';
import { regenerateAndStoreSlip, shouldQueuePrint } from '@/app/lib/packing-slip-store';

export const runtime = 'nodejs';

// POST /api/ebay/packing-slip/{orderNumber}/print
// Regenerates and overwrites the stored PDF with the current layout, then
// either lets the print agent auto-print (first print: packing_slip_url
// update with printed_at still null) or queues PACKING_SLIP_PRINT (reprints).
export async function POST(
    _request: NextRequest,
    { params }: { params: Promise<{ orderNumber: string }> }
) {
    const { orderNumber } = await params;

    let result: Awaited<ReturnType<typeof regenerateAndStoreSlip>>;
    try {
        result = await regenerateAndStoreSlip(orderNumber);
    } catch (err: any) {
        return NextResponse.json({ error: err.message || 'Failed to generate packing slip' }, { status: 500 });
    }
    if (!result) {
        return NextResponse.json({ error: `No sales found for order ${orderNumber}` }, { status: 404 });
    }

    if (!shouldQueuePrint(result.alreadyPrinted)) {
        return NextResponse.json({ ok: true, via: 'auto' });
    }

    const { error: insertErr } = await supabaseAdmin.from('ebay_webhook_events').insert({
        notification_id: `slip-print:${orderNumber}:${Date.now()}`,
        topic: 'PACKING_SLIP_PRINT',
        order_number: orderNumber,
    });
    if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 });
    return NextResponse.json({ ok: true, via: 'queue' });
}
