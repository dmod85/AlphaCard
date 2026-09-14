import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabase-admin';
import {
    fetchLabelCostForOrderDetailed,
    fetchSellerLabelCosts,
    matchLabelAmount,
} from '@/app/lib/ebay-finances';
import { applySellerLabelCosts } from '@/app/lib/ebay-label-costs';

// POST /api/ebay/seller-costs
//   { days?: number, orderId?: string, quick?: boolean, onlyBlank?: boolean }
// Null shipping_cost / advertising_fee stay pending on the sales page until
// Finances posts them. Postpaid eSE labels often land hours after the sale —
// quick mode scans SHIPPING_LABEL txs and writes shipping_cost. Combined
// invoices split the label across line items instead of dumping it on row 1.

export async function POST(request: NextRequest) {
    try {
        let days = 14;
        let orderId: string | null = null;
        let quick = false;
        let onlyBlank = false;
        try {
            const body = await request.json();
            if (body?.days) days = Math.min(Math.max(parseInt(body.days, 10) || 14, 1), 365);
            if (body?.orderId) orderId = String(body.orderId).trim();
            if (body?.quick) quick = true;
            if (body?.onlyBlank) onlyBlank = true;
        } catch {
            /* empty body */
        }

        const result = await applySellerLabelCosts({ days, orderId, quick, onlyBlank });
        if (result.error && result.status && result.status >= 400 && result.matchedOrders === 0 && result.labelsFound === 0) {
            return NextResponse.json(result, { status: result.status });
        }
        return NextResponse.json(result);
    } catch (err: any) {
        return NextResponse.json({ error: err.message || 'Failed to refresh label costs' }, { status: 500 });
    }
}

/** GET /api/ebay/seller-costs?orderId=18-15069-06112 — inspect Finances for one order */
export async function GET(request: NextRequest) {
    const orderId = request.nextUrl.searchParams.get('orderId')?.trim();
    if (!orderId) {
        return NextResponse.json({ error: 'orderId required' }, { status: 400 });
    }

    const { data: sale } = await supabaseAdmin
        .from('ebay_sales')
        .select('order_number, buyer, sale_date, tracking_number, sales_record_number, shipping_cost, shipped_at')
        .eq('order_number', orderId)
        .limit(1)
        .maybeSingle();

    const detail = await fetchLabelCostForOrderDetailed(orderId);

    let matchedViaBuyer: number | null = null;
    let unlabeled: { amount: number; date: string; buyer: string; orderId: string; refs: string }[] = [];
    let labelsFound = 0;
    let unlabeledCount = 0;
    if (sale?.sale_date) {
        const from = new Date(sale.sale_date);
        from.setDate(from.getDate() - 1);
        const to = new Date(sale.sale_date);
        to.setDate(to.getDate() + 10);
        const labels = await fetchSellerLabelCosts(from.toISOString(), to.toISOString());
        labelsFound = labels.labelsFound;
        unlabeledCount = labels.unlabeledCount;
        unlabeled = labels.sampleUnlabeled;
        matchedViaBuyer = matchLabelAmount(
            orderId,
            sale.sales_record_number,
            labels,
            sale.buyer,
            sale.sale_date,
            sale.shipped_at
        );
    }

    return NextResponse.json({
        orderId,
        saleBuyer: sale?.buyer || null,
        saleDate: sale?.sale_date || null,
        storedShipping: sale?.shipping_cost ?? null,
        ...detail,
        amount: detail.amount ?? matchedViaBuyer,
        matchedViaBuyer,
        labelsFoundNearby: labelsFound,
        unlabeledCount,
        unlabeledSample: unlabeled,
    });
}
