import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabase-admin';
import { fetchSellerLabelCosts, matchLabelAmount } from '@/app/lib/ebay-finances';

// POST /api/ebay/seller-costs
//   { days?: number }  — lookback for label purchase dates (default 90)
// Pulls seller-paid eBay shipping labels from Finances and writes shipping_cost
// onto matching ebay_sales rows. Does not call GetOrders.

export async function POST(request: NextRequest) {
    try {
        let days = 90;
        try {
            const body = await request.json();
            if (body?.days) days = Math.min(Math.max(parseInt(body.days, 10) || 90, 1), 365);
        } catch {
            // empty body is fine
        }

        const toDate = new Date();
        const fromDate = new Date();
        fromDate.setDate(fromDate.getDate() - days);
        fromDate.setHours(0, 0, 0, 0);

        const labels = await fetchSellerLabelCosts(fromDate.toISOString(), toDate.toISOString());
        if (labels.error && labels.labelsFound === 0) {
            return NextResponse.json(
                {
                    error: labels.error,
                    labelsFound: 0,
                    matchedOrders: 0,
                    updatedRows: 0,
                    sampleLabelOrderIds: labels.sampleOrderIds,
                },
                { status: labels.error === 'EBAY_AUTH_REQUIRED' ? 401 : 502 }
            );
        }

        const { data: sales, error: salesErr } = await supabaseAdmin
            .from('ebay_sales')
            .select('id, order_number, sales_record_number, sale_date')
            .order('sale_date', { ascending: true });
        if (salesErr) throw salesErr;

        const byOrder = new Map<string, typeof sales>();
        for (const s of sales ?? []) {
            const list = byOrder.get(s.order_number) ?? [];
            list.push(s);
            byOrder.set(s.order_number, list);
        }

        let matchedOrders = 0;
        let updatedRows = 0;

        for (const [orderNumber, lines] of Array.from(byOrder.entries())) {
            const record = lines[0]?.sales_record_number as string | null;
            const amount = matchLabelAmount(orderNumber, record, labels);
            if (amount == null) continue;
            matchedOrders += 1;

            for (let i = 0; i < lines.length; i++) {
                const shipping = i === 0 ? amount : 0;
                const { error } = await supabaseAdmin
                    .from('ebay_sales')
                    .update({ shipping_cost: shipping })
                    .eq('id', lines[i].id);
                if (!error) updatedRows += 1;
            }
        }

        const sampleSaleOrderIds = Array.from(byOrder.keys()).slice(0, 8);

        const { data: allSales, error: fetchErr } = await supabaseAdmin
            .from('ebay_sales')
            .select('*')
            .order('sale_date', { ascending: false });
        if (fetchErr) throw fetchErr;

        return NextResponse.json({
            sales: allSales ?? [],
            labelsFound: labels.labelsFound,
            matchedOrders,
            updatedRows,
            sampleLabelOrderIds: labels.sampleOrderIds,
            sampleSaleOrderIds,
            warning: labels.error,
        });
    } catch (err: any) {
        return NextResponse.json({ error: err.message || 'Failed to refresh label costs' }, { status: 500 });
    }
}
