import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabase-admin';
import {
    fetchSellerLabelCosts,
    fetchLabelCostForOrderDetailed,
    matchLabelAmount,
} from '@/app/lib/ebay-finances';

// POST /api/ebay/seller-costs
//   { days?: number, orderId?: string }
// Italic $0.78 on the sales page is the default estimate (null shipping_cost).

export async function POST(request: NextRequest) {
    try {
        let days = 90;
        let orderId: string | null = null;
        try {
            const body = await request.json();
            if (body?.days) days = Math.min(Math.max(parseInt(body.days, 10) || 90, 1), 365);
            if (body?.orderId) orderId = String(body.orderId).trim();
        } catch {
            /* empty body */
        }

        const toDate = new Date();
        const fromDate = new Date();
        fromDate.setDate(fromDate.getDate() - days);
        fromDate.setHours(0, 0, 0, 0);
        const cutoff = fromDate.toISOString();

        const { data: sales, error: salesErr } = await supabaseAdmin
            .from('ebay_sales')
            .select('id, order_number, sales_record_number, sale_date, tracking_number, shipping_cost')
            .order('sale_date', { ascending: true });
        if (salesErr) throw salesErr;

        type SaleLine = NonNullable<typeof sales>[number];
        const byOrder = new Map<string, SaleLine[]>();
        for (const s of sales ?? []) {
            const list = byOrder.get(s.order_number) ?? [];
            list.push(s);
            byOrder.set(s.order_number, list);
        }

        let matchedOrders = 0;
        let updatedRows = 0;
        let perOrderFilled = 0;
        let missingLookedUp = 0;
        let labelsFound = 0;
        let warning: string | null = null;
        const sampleLabelOrderIds: string[] = [];
        const applied: number[] = [];
        const matchedOrderNumbers = new Set<string>();
        let singleDebug: Record<string, unknown> | null = null;

        const writeEbayCosts = async (
            lines: SaleLine[],
            detail: { amount: number | null; ebayFee: number | null; adFee: number | null; buyerShipping: number | null }
        ) => {
            for (let i = 0; i < lines.length; i++) {
                const first = i === 0;
                const patch: Record<string, number | null> = {};
                if (detail.amount != null) patch.shipping_cost = first ? detail.amount : 0;
                if (detail.ebayFee != null) patch.ebay_fee = first ? detail.ebayFee : 0;
                if (detail.adFee != null) patch.advertising_fee = first ? detail.adFee : 0;
                if (detail.buyerShipping != null) patch.order_shipping_cost = first ? detail.buyerShipping : 0;
                if (Object.keys(patch).length === 0) continue;
                const { error } = await supabaseAdmin
                    .from('ebay_sales')
                    .update(patch)
                    .eq('id', lines[i].id);
                if (!error) updatedRows += 1;
            }
        };

        if (orderId) {
            const lines = byOrder.get(orderId);
            if (!lines?.length) {
                return NextResponse.json(
                    { error: `No sale row with order_number ${orderId}` },
                    { status: 404 }
                );
            }
            const detail = await fetchLabelCostForOrderDetailed(orderId);
            singleDebug = { orderId, ...detail };
            if (detail.amount != null || detail.ebayFee != null || detail.adFee != null) {
                await writeEbayCosts(lines, detail);
                matchedOrders = 1;
                perOrderFilled = 1;
                labelsFound = 1;
                if (detail.amount != null) applied.push(detail.amount);
            }
        } else {
            const labels = await fetchSellerLabelCosts(fromDate.toISOString(), toDate.toISOString());
            labelsFound = labels.labelsFound;
            warning = labels.error;
            for (let i = 0; i < labels.sampleOrderIds.length; i++) {
                sampleLabelOrderIds.push(labels.sampleOrderIds[i]);
            }

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

            for (const [orderNumber, lines] of Array.from(byOrder.entries())) {
                const record = lines[0]?.sales_record_number as string | null;
                const amount = matchLabelAmount(orderNumber, record, labels);
                if (amount == null) continue;
                matchedOrders += 1;
                matchedOrderNumbers.add(orderNumber);
                applied.push(amount);
                await writeEbayCosts(lines, {
                    amount,
                    ebayFee: null,
                    adFee: null,
                    buyerShipping: null,
                });
            }

            // Only look up orders that still have blank shipping (italic default)
            // in the selected lookback, newest first. Previously we scanned the
            // oldest 200 orders and timed out before reaching today's sales.
            const missing = Array.from(byOrder.entries())
                .map(([orderNumber, lines]) => {
                    const latest = lines.reduce((max, l) => {
                        const d = l.sale_date || '';
                        return d > max ? d : max;
                    }, '');
                    return { orderNumber, lines, latest };
                })
                .filter((x) => {
                    if (matchedOrderNumbers.has(x.orderNumber)) return false;
                    const inRange = x.latest >= cutoff;
                    const blank = x.lines.some((l) => l.shipping_cost == null);
                    return inRange && blank;
                })
                .sort((a, b) => (a.latest < b.latest ? 1 : -1))
                .slice(0, 80);
            missingLookedUp = missing.length;

            const CHUNK = 8;
            for (let i = 0; i < missing.length; i += CHUNK) {
                const chunk = missing.slice(i, i + CHUNK);
                await Promise.all(
                    chunk.map(async ({ orderNumber, lines }) => {
                        const detail = await fetchLabelCostForOrderDetailed(orderNumber);
                        if (
                            detail.amount == null &&
                            detail.ebayFee == null &&
                            detail.adFee == null
                        ) {
                            return;
                        }
                        perOrderFilled += 1;
                        if (!matchedOrderNumbers.has(orderNumber)) matchedOrders += 1;
                        if (detail.amount != null) applied.push(detail.amount);
                        await writeEbayCosts(lines, detail);
                    })
                );
            }
        }

        applied.sort((a, b) => a - b);
        const typicalLabelCost = applied.length ? applied[Math.floor(applied.length / 2)] : null;
        const minLabelCost = applied.length ? applied[0] : null;
        const maxLabelCost = applied.length ? applied[applied.length - 1] : null;

        const { data: allSales, error: fetchErr } = await supabaseAdmin
            .from('ebay_sales')
            .select('*')
            .order('sale_date', { ascending: false });
        if (fetchErr) throw fetchErr;

        return NextResponse.json({
            sales: allSales ?? [],
            labelsFound,
            matchedOrders,
            updatedRows,
            perOrderFilled,
            missingLookedUp,
            typicalLabelCost,
            minLabelCost,
            maxLabelCost,
            sampleLabelOrderIds,
            sampleSaleOrderIds: Array.from(byOrder.keys()).slice(0, 8),
            warning,
            debug: singleDebug,
        });
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
    const detail = await fetchLabelCostForOrderDetailed(orderId);
    return NextResponse.json({ orderId, ...detail });
}
