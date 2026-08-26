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

export type LabelCostResult = {
    byOrderId: Map<string, number>;
    bySalesRecord: Map<string, number>;
    labelsFound: number;
    sampleOrderIds: string[];
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

export async function fetchSellerLabelCosts(
    fromIso: string,
    toIso: string
): Promise<LabelCostResult> {
    const byOrderId = new Map<string, number>();
    const bySalesRecord = new Map<string, number>();
    const sampleOrderIds: string[] = [];
    let labelsFound = 0;
    let token: string;
    try {
        token = await getValidToken();
    } catch {
        return { byOrderId, bySalesRecord, labelsFound, sampleOrderIds, error: 'EBAY_AUTH_REQUIRED' };
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
                return {
                    byOrderId,
                    bySalesRecord,
                    labelsFound,
                    sampleOrderIds,
                    error:
                        'Finances access denied. Reconnect eBay at /ebay-connect (Agree to the updated permissions), then use Refresh label costs.',
                };
            }

            if (!res.ok) {
                const body = await res.text();
                console.error('[ebay-finances] getTransactions failed:', res.status, body.slice(0, 800));
                return {
                    byOrderId,
                    bySalesRecord,
                    labelsFound,
                    sampleOrderIds,
                    error: `Finances API ${res.status}: ${body.slice(0, 180)}`,
                };
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
                addAmount(byOrderId, tx.orderId, amt);
                addAmount(bySalesRecord, tx.salesRecordReference, amt);
                for (const ref of tx.references ?? []) {
                    if (/order/i.test(ref.referenceType || '')) addAmount(byOrderId, ref.referenceId, amt);
                }
                if (tx.orderId && sampleOrderIds.length < 8) sampleOrderIds.push(tx.orderId);
            }

            offset += txs.length;
            if (txs.length < limit) break;
        }
    } catch (err: any) {
        console.error('[ebay-finances] fetch error:', err);
        return {
            byOrderId,
            bySalesRecord,
            labelsFound,
            sampleOrderIds,
            error: err.message || 'Finances fetch failed',
        };
    }

    return { byOrderId, bySalesRecord, labelsFound, sampleOrderIds, error: null };
}

export function matchLabelAmount(
    orderNumber: string,
    salesRecord: string | null | undefined,
    labels: LabelCostResult
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
    return null;
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
            shippingLabel += signedAmount(tx);
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
    const txTypes = txs.map((t) => `${t.transactionType || '?'}:${t.amount?.value || '?'}`);
    const fromTx = parseTransactionCosts(txs);

    const earnings = await fetchOrderEarningsRaw(token, orderId);
    const fromEarn = earnings
        ? parseOrderEarnings(earnings)
        : { shippingLabel: null, ebayFee: null, adFee: null, buyerShipping: null };

    const amount = fromTx.shippingLabel ?? fromEarn.shippingLabel ?? null;
    const source = fromTx.shippingLabel != null ? 'transaction' : fromEarn.shippingLabel != null ? 'order_earnings' : null;

    return {
        amount,
        source,
        txTypes,
        ebayFee: fromTx.ebayFee ?? fromEarn.ebayFee,
        adFee: fromTx.adFee ?? fromEarn.adFee,
        buyerShipping: fromEarn.buyerShipping,
    };
}
