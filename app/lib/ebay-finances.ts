import { getValidToken } from '@/app/lib/ebay-auth';

/**
 * Seller-paid eBay shipping label costs from the Finances API.
 * GetOrders.ActualShippingCost is what the *buyer* paid — not this.
 *
 * GET https://apiz.ebay.com/sell/finances/v1/transaction
 *   filter=transactionType:{SHIPPING_LABEL}
 * Requires scope: https://api.ebay.com/oauth/api_scope/sell.finances
 *
 * eBay's filter language needs literal `{ } [ ] :` in the query string.
 * URLSearchParams encodes those and the API then returns nothing useful.
 */

function financesRoot(): string {
    return process.env.EBAY_ENVIRONMENT?.trim() === 'PRODUCTION'
        ? 'https://apiz.ebay.com'
        : 'https://apiz.sandbox.ebay.com';
}

export type UnlabeledLabel = {
    amount: number;
    date: string;
    buyer: string;
    orderId: string;
    refs: string;
};

export type LabelCostResult = {
    byOrderId: Map<string, number>;
    bySalesRecord: Map<string, number>;
    byBuyerDate: Map<string, number[]>;
    byOrderBuyer: Map<string, string>;
    unlabeled: UnlabeledLabel[];
    labelsFound: number;
    unlabeledCount: number;
    sampleOrderIds: string[];
    sampleUnlabeled: UnlabeledLabel[];
    error: string | null;
};

interface FinancesTransaction {
    orderId?: string;
    salesRecordReference?: string;
    transactionType?: string;
    transactionMemo?: string;
    feeType?: string;
    bookingEntry?: string;
    amount?: { value?: string; currency?: string };
    transactionDate?: string;
    buyer?: { username?: string };
    references?: Array<{ referenceType?: string; referenceId?: string }>;
    orderLineItems?: Array<{
        marketplaceFees?: Array<{
            feeType?: string;
            amount?: { value?: string; currency?: string };
        }>;
    }>;
}

function signedAmount(tx: FinancesTransaction): number {
    const raw = parseFloat(tx.amount?.value || '');
    if (!Number.isFinite(raw)) return 0;
    return tx.bookingEntry === 'CREDIT' ? -raw : raw;
}

function addAmount(map: Map<string, number>, key: string | undefined, amt: number) {
    const k = (key || '').trim();
    if (!k || k === '0') return;
    map.set(k, (map.get(k) ?? 0) + amt);
}

function buyerDateKey(buyer: string, day: string) {
    return `${buyer.trim().toLowerCase()}|${day.slice(0, 10)}`;
}

function emptyLabelResult(error: string | null): LabelCostResult {
    return {
        byOrderId: new Map(),
        bySalesRecord: new Map(),
        byBuyerDate: new Map(),
        byOrderBuyer: new Map(),
        unlabeled: [],
        labelsFound: 0,
        unlabeledCount: 0,
        sampleOrderIds: [],
        sampleUnlabeled: [],
        error,
    };
}

export async function fetchSellerLabelCosts(
    fromIso: string,
    toIso: string
): Promise<LabelCostResult> {
    const byOrderId = new Map<string, number>();
    const bySalesRecord = new Map<string, number>();
    const byBuyerDate = new Map<string, number[]>();
    const byOrderBuyer = new Map<string, string>();
    const unlabeled: UnlabeledLabel[] = [];
    const sampleOrderIds: string[] = [];
    let labelsFound = 0;
    let unlabeledCount = 0;
    let token: string;
    try {
        token = await getValidToken();
    } catch {
        return emptyLabelResult('EBAY_AUTH_REQUIRED');
    }

    const limit = 200;
    let offset = 0;
    let total = Infinity;

    try {
        while (offset < total) {
            const qs =
                `filter=transactionType:{SHIPPING_LABEL}` +
                `&filter=transactionDate:[${fromIso}..${toIso}]` +
                `&limit=${limit}&offset=${offset}`;

            const res = await fetch(`${financesRoot()}/sell/finances/v1/transaction?${qs}`, {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/json',
                    'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
                },
            });

            if (res.status === 204) break;

            if (res.status === 401 || res.status === 403) {
                const body = await res.text();
                console.error('[ebay-finances] auth/scope error:', res.status, body.slice(0, 800));
                return emptyLabelResult(
                    'Finances access denied. Reconnect eBay at /ebay-connect (Agree to the updated permissions), then use Refresh label costs.'
                );
            }

            if (!res.ok) {
                const body = await res.text();
                console.error('[ebay-finances] getTransactions failed:', res.status, body.slice(0, 800));
                return emptyLabelResult(`Finances API ${res.status}: ${body.slice(0, 180)}`);
            }

            const data = (await res.json()) as {
                total?: number;
                transactions?: FinancesTransaction[];
            };
            total = data.total ?? 0;
            const txs = data.transactions ?? [];
            if (txs.length === 0) break;

            for (const tx of txs) {
                const amt = signedAmount(tx);
                if (!amt) continue;
                labelsFound += 1;
                const hadOrder = !!(tx.orderId && tx.orderId !== '0');
                const user = tx.buyer?.username;
                
                const orderIds = new Set<string>();
                if (hadOrder) orderIds.add(tx.orderId!);
                for (const ref of tx.references ?? []) {
                    if (ref.referenceType === 'ORDER_ID' && ref.referenceId && ref.referenceId !== '0') {
                        orderIds.add(ref.referenceId);
                    }
                }
                const splitAmt = orderIds.size > 0 ? amt / orderIds.size : amt;
                
                for (const oid of orderIds) {
                    addAmount(byOrderId, oid, splitAmt);
                    if (user) byOrderBuyer.set(oid, user);
                }
                addAmount(bySalesRecord, tx.salesRecordReference, splitAmt);
                
                const refBits: string[] = [];
                for (const ref of tx.references ?? []) {
                    if (ref.referenceType !== 'ORDER_ID') {
                        addAmount(byOrderId, ref.referenceId, splitAmt);
                    }
                    refBits.push(`${ref.referenceType || ''}:${ref.referenceId || ''}`);
                }
                if (!hadOrder) {
                    unlabeledCount += 1;
                    unlabeled.push({
                        amount: amt,
                        date: tx.transactionDate || '',
                        buyer: user || '',
                        orderId: tx.orderId || '',
                        refs: refBits.join(',') || (tx.salesRecordReference || ''),
                    });
                }
                const day = tx.transactionDate || '';
                if (user && day) {
                    const k = buyerDateKey(user, day);
                    const arr = byBuyerDate.get(k) ?? [];
                    arr.push(amt);
                    byBuyerDate.set(k, arr);
                }
                if (tx.orderId && sampleOrderIds.length < 8) sampleOrderIds.push(tx.orderId);
            }

            offset += txs.length;
            if (txs.length < limit) break;
        }
    } catch (err: any) {
        console.error('[ebay-finances] fetch error:', err);
        return emptyLabelResult(err.message || 'Finances fetch failed');
    }

    return {
        byOrderId,
        bySalesRecord,
        byBuyerDate,
        byOrderBuyer,
        unlabeled,
        labelsFound,
        unlabeledCount,
        sampleOrderIds,
        sampleUnlabeled: unlabeled.slice(0, 15),
        error: null,
    };
}

function dateOffsets(iso: string, from: number, to: number): string[] {
    const days: string[] = [];
    for (let i = from; i <= to; i++) {
        const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
        d.setUTCDate(d.getUTCDate() + i);
        days.push(d.toISOString().slice(0, 10));
    }
    return days;
}

export function matchLabelAmount(
    orderNumber: string,
    salesRecord: string | null | undefined,
    labels: LabelCostResult,
    buyer?: string | null,
    saleDate?: string | null,
    shippedAt?: string | null
): number | null {
    if (labels.byOrderId.has(orderNumber)) return labels.byOrderId.get(orderNumber)!;
    if (salesRecord && labels.bySalesRecord.has(salesRecord)) {
        return labels.bySalesRecord.get(salesRecord)!;
    }
    const needle = orderNumber.toLowerCase();
    const ids = Array.from(labels.byOrderId.keys());
    for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const hay = id.toLowerCase();
        if (hay === needle || hay.endsWith(needle) || needle.endsWith(hay)) {
            return labels.byOrderId.get(id) ?? null;
        }
    }
    // Postpaid eSE labels often omit orderId. Match buyer across sale→ship window.
    if (buyer && (saleDate || shippedAt) && labels.byBuyerDate) {
        const days = new Set<string>();
        if (saleDate) dateOffsets(saleDate, -1, 10).forEach((d) => days.add(d));
        if (shippedAt) dateOffsets(shippedAt, -1, 2).forEach((d) => days.add(d));
        const candidates: number[] = [];
        days.forEach((day) => {
            const arr = labels.byBuyerDate.get(buyerDateKey(buyer, day));
            if (arr) arr.forEach((a) => candidates.push(a));
        });
        if (candidates.length === 1) return candidates[0];
        if (candidates.length > 1 && candidates.every((a) => a === candidates[0])) {
            return candidates[0];
        }
    }
    return null;
}

export type LabelMatchOrder = {
    orderNumber: string;
    buyer?: string | null;
    saleDate?: string | null;
    shippedAt?: string | null;
    tracking?: string | null;
    service?: string | null;
};

function ms(iso: string | null | undefined): number | null {
    if (!iso) return null;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : null;
}

function isEseService(service: string | null | undefined): boolean {
    return /envelope|ese|uspsfirstclass|us_first_class/i.test(service || '');
}

function isEseAmount(n: number): boolean {
    return n >= 0.5 && n <= 1.5;
}

function labelInOrderWindow(labelMs: number, saleMs: number | null, shipMs: number | null): boolean {
    const start = (saleMs ?? shipMs);
    if (start == null) return false;
    const end = (shipMs ?? saleMs)! + 10 * 24 * 3600 * 1000;
    return labelMs >= start - 24 * 3600 * 1000 && labelMs <= end;
}

/** 1:1 assign unlabeled SHIPPING_LABEL charges to unmatched shipped orders. */
export function assignUnlabeledLabels(
    orders: LabelMatchOrder[],
    unlabeled: UnlabeledLabel[],
    alreadyMatched: Set<string>
): Map<string, number> {
    const assigned = new Map<string, number>();
    const remaining = unlabeled.filter((l) => l.amount > 0).map((l) => ({ ...l }));
    const open = orders.filter((o) => !alreadyMatched.has(o.orderNumber));

    const take = (orderNumber: string, idx: number) => {
        assigned.set(orderNumber, remaining[idx].amount);
        remaining.splice(idx, 1);
    };

    for (const o of open) {
        if (!o.buyer) continue;
        const buyer = o.buyer.trim().toLowerCase();
        const hits: number[] = [];
        for (let i = 0; i < remaining.length; i++) {
            const l = remaining[i];
            if ((l.buyer || '').trim().toLowerCase() !== buyer) continue;
            const lms = ms(l.date);
            if (lms == null) continue;
            if (!labelInOrderWindow(lms, ms(o.saleDate), ms(o.shippedAt))) continue;
            hits.push(i);
        }
        if (hits.length === 1) take(o.orderNumber, hits[0]);
        else if (hits.length > 1 && hits.every((i) => remaining[i].amount === remaining[hits[0]].amount)) {
            take(o.orderNumber, hits[0]);
        }
    }

    const leftover = open.filter(
        (o) => !assigned.has(o.orderNumber) && (o.tracking || o.shippedAt)
    );
    for (let li = remaining.length - 1; li >= 0; li--) {
        const l = remaining[li];
        const lms = ms(l.date);
        if (lms == null) continue;
        let best: { orderNumber: string; dist: number } | null = null;
        for (const o of leftover) {
            if (assigned.has(o.orderNumber)) continue;
            if (isEseService(o.service) !== isEseAmount(l.amount)) continue;
            const saleMs = ms(o.saleDate);
            const shipMs = ms(o.shippedAt);
            if (!labelInOrderWindow(lms, saleMs, shipMs)) continue;
            const dist = Math.abs(lms - (shipMs ?? saleMs)!);
            if (dist > 3 * 24 * 3600 * 1000) continue;
            if (!best || dist < best.dist) best = { orderNumber: o.orderNumber, dist };
        }
        if (best) {
            assigned.set(best.orderNumber, l.amount);
            remaining.splice(li, 1);
        }
    }

    return assigned;
}

async function financesGet(token: string, qs: string): Promise<{
    status: number;
    json: { total?: number; transactions?: FinancesTransaction[] };
    text: string;
}> {
    const res = await fetch(`${financesRoot()}/sell/finances/v1/transaction?${qs}`, {
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
        },
    });
    const text = await res.text();
    let json: { total?: number; transactions?: FinancesTransaction[] } = {};
    if (text && res.status !== 204) {
        try { json = JSON.parse(text); } catch { /* ignore */ }
    }
    return { status: res.status, json, text };
}

function classifyFee(type: string, amt: number, into: { ebayFee: number; adFee: number; hasFee: boolean; hasAd: boolean }) {
    const t = type.toUpperCase();
    if (t.includes('AD_FEE') || t.includes('ADVERTISE') || t.includes('PROMOTED')) {
        into.adFee += amt;
        into.hasAd = true;
    } else if (
        t.includes('FINAL_VALUE') ||
        t.includes('INSERTION') ||
        t.includes('BELOW_STANDARD') ||
        t.includes('REGULATORY')
    ) {
        into.ebayFee += amt;
        into.hasFee = true;
    }
}

function parseTransactionCosts(txs: FinancesTransaction[]): OrderEarningsCosts {
    let shippingLabel = 0;
    let hasLabel = false;
    const fees = { ebayFee: 0, adFee: 0, hasFee: false, hasAd: false };

    for (const tx of txs) {
        const type = (tx.transactionType || '').toUpperCase();
        const memo = String(tx.transactionMemo || '');
        if (
            type === 'SHIPPING_LABEL' ||
            /shipping\s*label/i.test(memo) ||
            (type === 'NON_SALE_CHARGE' && /SHIPPING/i.test(tx.feeType || ''))
        ) {
            const orderIds = new Set<string>();
            if (tx.orderId && tx.orderId !== '0') orderIds.add(tx.orderId);
            for (const ref of tx.references ?? []) {
                if (ref.referenceType === 'ORDER_ID' && ref.referenceId && ref.referenceId !== '0') {
                    orderIds.add(ref.referenceId);
                }
            }
            const divisor = Math.max(1, orderIds.size);
            shippingLabel += signedAmount(tx) / divisor;
            hasLabel = true;
        }
        if (tx.feeType && type !== 'SHIPPING_LABEL' && type !== 'NON_SALE_CHARGE') {
            classifyFee(tx.feeType, Math.abs(signedAmount(tx)), fees);
        } else if (tx.feeType && type === 'NON_SALE_CHARGE' && !/SHIPPING/i.test(tx.feeType || '')) {
            classifyFee(tx.feeType, Math.abs(signedAmount(tx)), fees);
        }
        const lines = tx.orderLineItems || [];
        for (let i = 0; i < lines.length; i++) {
            const mfees = lines[i].marketplaceFees || [];
            for (let j = 0; j < mfees.length; j++) {
                const amt = absMoney(mfees[j].amount?.value);
                if (amt != null) classifyFee(mfees[j].feeType || '', amt, fees);
            }
        }
    }

    return {
        shippingLabel: hasLabel ? Math.round(Math.abs(shippingLabel) * 100) / 100 : null,
        ebayFee: fees.hasFee ? Math.round(fees.ebayFee * 100) / 100 : null,
        adFee: fees.hasAd ? Math.round(fees.adFee * 100) / 100 : null,
        buyerShipping: null,
    };
}

function absMoney(v: unknown): number | null {
    const n = parseFloat(String(v ?? ''));
    if (!Number.isFinite(n) || n === 0) return null;
    return Math.abs(n);
}

export type OrderEarningsCosts = {
    shippingLabel: number | null;
    ebayFee: number | null;
    adFee: number | null;
    buyerShipping: number | null;
};

export function parseOrderEarnings(data: any): OrderEarningsCosts {
    const summary = data?.orderEarningsSummary || data || {};
    const expenses = summary.expenses || {};
    const fees: any[] = expenses.marketplaceFees || [];
    let ebayFee = 0;
    let adFee = 0;
    let hasFee = false;
    let hasAd = false;
    for (const f of fees) {
        const type = String(f.feeType || '').toUpperCase();
        const amt = absMoney(f.amount?.value);
        if (amt == null) continue;
        if (type.includes('AD_FEE') || type.includes('ADVERTISE') || type.includes('PROMOTED')) {
            adFee += amt;
            hasAd = true;
        } else if (
            type.includes('FINAL_VALUE') ||
            type.includes('INSERTION') ||
            type.includes('BELOW_STANDARD') ||
            type.includes('REGULATORY')
        ) {
            ebayFee += amt;
            hasFee = true;
        }
    }
    return {
        shippingLabel: absMoney(expenses.shippingLabels?.value),
        ebayFee: hasFee ? Math.round(ebayFee * 100) / 100 : null,
        adFee: hasAd ? Math.round(adFee * 100) / 100 : null,
        buyerShipping: absMoney(data?.orderSummary?.shippingAndHandlingCosts?.value),
    };
}

async function fetchOrderEarningsRaw(token: string, orderId: string): Promise<any | null> {
    const res = await fetch(
        `${financesRoot()}/sell/finances/v1/order_earnings/${encodeURIComponent(orderId)}`,
        {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/json',
                'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
            },
        }
    );
    if (!res.ok) return null;
    return res.json();
}

export type OrderLabelLookup = {
    amount: number | null;
    source: 'transaction' | 'order_earnings' | null;
    txTypes: string[];
    ebayFee: number | null;
    adFee: number | null;
    buyerShipping: number | null;
};

/** Look up seller-paid labels for one order (date-range scan misses a lot of eSE labels). */
export async function fetchLabelCostForOrder(orderId: string): Promise<number | null> {
    const detail = await fetchLabelCostForOrderDetailed(orderId);
    return detail.amount;
}

export async function fetchLabelCostForOrderDetailed(orderId: string): Promise<OrderLabelLookup> {
    const empty: OrderLabelLookup = {
        amount: null,
        source: null,
        txTypes: [],
        ebayFee: null,
        adFee: null,
        buyerShipping: null,
    };
    let token: string;
    try {
        token = await getValidToken();
    } catch {
        return empty;
    }

    const qs = `filter=orderId:{${orderId}}&limit=200`;
    const { status, json } = await financesGet(token, qs);
    const txs = status < 400 ? (json.transactions ?? []) : [];
    const txTypes = [
        `http:${status}`,
        ...txs.map((t) => `${t.transactionType || '?'}:${t.amount?.value || '?'}:${t.feeType || ''}`),
    ];
    const fromTx = parseTransactionCosts(txs);

    let fromEarn: OrderEarningsCosts = {
        shippingLabel: null,
        ebayFee: null,
        adFee: null,
        buyerShipping: null,
    };
    // Skip order_earnings when transactions already have label + ads (it's slow
    // and often 403 without a separate growth-check grant).
    const needEarnings =
        fromTx.shippingLabel == null || fromTx.adFee == null || fromTx.ebayFee == null;
    if (needEarnings) {
        const earnings = await fetchOrderEarningsRaw(token, orderId);
        if (earnings) fromEarn = parseOrderEarnings(earnings);
    }

    let amount = fromTx.shippingLabel ?? fromEarn.shippingLabel ?? null;
    let source: OrderLabelLookup['source'] =
        fromTx.shippingLabel != null ? 'transaction' : fromEarn.shippingLabel != null ? 'order_earnings' : null;

    if (amount == null) {
        const fromFulfillment = await fetchFulfillmentLabelCost(token, orderId);
        if (fromFulfillment != null) {
            amount = fromFulfillment;
            source = 'order_earnings';
            txTypes.push(`fulfillment_label:${fromFulfillment}`);
        }
    }

    return {
        amount,
        source,
        txTypes,
        ebayFee: fromTx.ebayFee ?? fromEarn.ebayFee,
        adFee: fromTx.adFee ?? fromEarn.adFee,
        buyerShipping: fromEarn.buyerShipping,
    };
}

async function fetchFulfillmentLabelCost(token: string, orderId: string): Promise<number | null> {
    const root = process.env.EBAY_ENVIRONMENT?.trim() === 'PRODUCTION'
        ? 'https://api.ebay.com'
        : 'https://api.sandbox.ebay.com';
    try {
        const res = await fetch(`${root}/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}`, {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/json',
                'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
            },
        });
        if (!res.ok) return null;
        const data = await res.json();
        const hits: number[] = [];
        const walk = (o: any) => {
            if (!o || typeof o !== 'object') return;
            const keys = Object.keys(o);
            for (let i = 0; i < keys.length; i++) {
                const k = keys[i];
                const v = o[k];
                if (/label/i.test(k) && v && typeof v === 'object' && v.value != null) {
                    const n = Math.abs(parseFloat(v.value));
                    if (Number.isFinite(n) && n > 0 && n < 80) hits.push(n);
                }
                if (v && typeof v === 'object') walk(v);
            }
        };
        walk(data);
        return hits.length ? hits[0] : null;
    } catch {
        return null;
    }
}


