import { supabaseAdmin } from '@/app/lib/supabase-admin';
import {
    assignUnlabeledLabels,
    fetchLabelCostForOrderDetailed,
    fetchSellerLabelCosts,
    matchLabelAmount,
} from '@/app/lib/ebay-finances';

export type ApplyLabelCostsOpts = {
    days?: number;
    orderId?: string | null;
    /** Bulk SHIPPING_LABEL scan only — skip slow per-order Finances lookups. */
    quick?: boolean;
    /** Fill null shipping_cost only; do not overwrite a stored amount. */
    onlyBlank?: boolean;
};

export type ApplyLabelCostsResult = {
    sales: Record<string, unknown>[];
    labelsFound: number;
    matchedOrders: number;
    updatedRows: number;
    perOrderFilled: number;
    missingLookedUp: number;
    typicalLabelCost: number | null;
    minLabelCost: number | null;
    maxLabelCost: number | null;
    sampleLabelOrderIds: string[];
    sampleSaleOrderIds: string[];
    warning: string | null;
    debug: Record<string, unknown> | null;
    error?: string;
    status?: number;
};

type SaleLine = {
    id: string;
    order_number: string;
    sales_record_number: string | null;
    sale_date: string | null;
    tracking_number: string | null;
    shipping_cost: number | null;
    buyer: string | null;
    shipping_service?: string | null;
    shipped_at?: string | null;
};

export async function applySellerLabelCosts(
    opts: ApplyLabelCostsOpts = {}
): Promise<ApplyLabelCostsResult> {
    const days = Math.min(Math.max(opts.days ?? 90, 1), 365);
    const orderId = opts.orderId?.trim() || null;
    const quick = !!opts.quick;
    const onlyBlank = !!opts.onlyBlank;

    const toDate = new Date();
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - days);
    fromDate.setHours(0, 0, 0, 0);
    const cutoff = fromDate.toISOString();

    const { data: sales, error: salesErr } = await supabaseAdmin
        .from('ebay_sales')
        .select(
            'id, order_number, sales_record_number, sale_date, tracking_number, shipping_cost, buyer, shipping_service, shipped_at'
        )
        .order('sale_date', { ascending: true });
    if (salesErr) throw salesErr;

    const byOrder = new Map<string, SaleLine[]>();
    for (const s of (sales ?? []) as SaleLine[]) {
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
        detail: {
            amount: number | null;
            ebayFee?: number | null;
            adFee?: number | null;
            buyerShipping?: number | null;
            buyer?: string | null;
        }
    ) => {
        for (let i = 0; i < lines.length; i++) {
            const first = i === 0;
            const line = lines[i];
            const patch: Record<string, number | string | null> = {};
            if (detail.amount != null) {
                const blank = line.shipping_cost == null;
                if (!onlyBlank || blank) patch.shipping_cost = first ? detail.amount : 0;
            }
            if (detail.ebayFee != null) patch.ebay_fee = first ? detail.ebayFee : 0;
            if (detail.adFee != null) patch.advertising_fee = first ? detail.adFee : 0;
            if (detail.buyerShipping != null) {
                patch.order_shipping_cost = first ? detail.buyerShipping : 0;
            }
            if (first && detail.buyer && !line.buyer) patch.buyer = detail.buyer;
            if (Object.keys(patch).length === 0) continue;
            const { error } = await supabaseAdmin.from('ebay_sales').update(patch).eq('id', line.id);
            if (!error) {
                updatedRows += 1;
                if (patch.shipping_cost != null) line.shipping_cost = Number(patch.shipping_cost);
                if (typeof patch.buyer === 'string') line.buyer = patch.buyer;
            }
        }
    };

    const emptySales = async (): Promise<Record<string, unknown>[]> => {
        const { data, error } = await supabaseAdmin
            .from('ebay_sales')
            .select('*')
            .order('sale_date', { ascending: false });
        if (error) throw error;
        return (data ?? []) as Record<string, unknown>[];
    };

    if (orderId) {
        const lines = byOrder.get(orderId);
        if (!lines?.length) {
            return {
                sales: [],
                labelsFound: 0,
                matchedOrders: 0,
                updatedRows: 0,
                perOrderFilled: 0,
                missingLookedUp: 0,
                typicalLabelCost: null,
                minLabelCost: null,
                maxLabelCost: null,
                sampleLabelOrderIds: [],
                sampleSaleOrderIds: [],
                warning: null,
                debug: { orderId },
                error: `No sale row with order_number ${orderId}`,
                status: 404,
            };
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
        if (!warning && labels.unlabeledCount > 0) {
            warning = `${labels.unlabeledCount} shipping-label charges have no order id — matching those by buyer + date.`;
        }
        for (let i = 0; i < labels.sampleOrderIds.length; i++) {
            sampleLabelOrderIds.push(labels.sampleOrderIds[i]);
        }

        if (labels.error && labels.labelsFound === 0) {
            return {
                sales: await emptySales(),
                labelsFound: 0,
                matchedOrders: 0,
                updatedRows: 0,
                perOrderFilled: 0,
                missingLookedUp: 0,
                typicalLabelCost: null,
                minLabelCost: null,
                maxLabelCost: null,
                sampleLabelOrderIds: labels.sampleOrderIds,
                sampleSaleOrderIds: Array.from(byOrder.keys()).slice(0, 8),
                warning: labels.error,
                debug: null,
                error: labels.error,
                status: labels.error === 'EBAY_AUTH_REQUIRED' ? 401 : 502,
            };
        }

        if (onlyBlank) {
            for (const [orderNumber, lines] of Array.from(byOrder.entries())) {
                if (lines[0]?.shipping_cost != null) matchedOrderNumbers.add(orderNumber);
            }
        }

        for (const [orderNumber, lines] of Array.from(byOrder.entries())) {
            if (matchedOrderNumbers.has(orderNumber)) continue;
            const head = lines[0];
            const amount = matchLabelAmount(
                orderNumber,
                head?.sales_record_number,
                labels,
                head?.buyer,
                head?.sale_date,
                head?.shipped_at
            );
            if (amount == null) continue;
            matchedOrders += 1;
            matchedOrderNumbers.add(orderNumber);
            applied.push(amount);
            await writeEbayCosts(lines, {
                amount,
                buyer: labels.byOrderBuyer.get(orderNumber) || null,
            });
        }

        const greedy = assignUnlabeledLabels(
            Array.from(byOrder.entries()).map(([orderNumber, lines]) => ({
                orderNumber,
                buyer: lines[0]?.buyer,
                saleDate: lines[0]?.sale_date,
                shippedAt: lines[0]?.shipped_at,
                tracking: lines[0]?.tracking_number,
                service: lines[0]?.shipping_service,
            })),
            labels.unlabeled,
            matchedOrderNumbers
        );
        for (const [orderNumber, amount] of Array.from(greedy.entries())) {
            const lines = byOrder.get(orderNumber);
            if (!lines) continue;
            matchedOrders += 1;
            matchedOrderNumbers.add(orderNumber);
            applied.push(amount);
            await writeEbayCosts(lines, { amount });
        }

        if (!quick) {
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
                        if (detail.amount == null) {
                            const fallback = matchLabelAmount(
                                orderNumber,
                                lines[0]?.sales_record_number,
                                labels,
                                lines[0]?.buyer,
                                lines[0]?.sale_date,
                                lines[0]?.shipped_at
                            );
                            if (fallback != null) detail.amount = fallback;
                        }
                        if (
                            detail.amount == null &&
                            detail.ebayFee == null &&
                            detail.adFee == null
                        ) {
                            return;
                        }
                        perOrderFilled += 1;
                        if (!matchedOrderNumbers.has(orderNumber)) matchedOrders += 1;
                        if (detail.amount != null) {
                            applied.push(detail.amount);
                            matchedOrderNumbers.add(orderNumber);
                        }
                        await writeEbayCosts(lines, detail);
                    })
                );
            }
        }
    }

    applied.sort((a, b) => a - b);
    const typicalLabelCost = applied.length ? applied[Math.floor(applied.length / 2)] : null;
    const minLabelCost = applied.length ? applied[0] : null;
    const maxLabelCost = applied.length ? applied[applied.length - 1] : null;

    return {
        sales: await emptySales(),
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
    };
}
