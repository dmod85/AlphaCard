import { getValidToken } from '@/app/lib/ebay-auth';

/**
 * Seller-paid eBay shipping label costs from the Finances API.
 * GetOrders.ActualShippingCost is what the *buyer* paid — not this.
 *
 * GET https://apiz.ebay.com/sell/finances/v1/transaction
 *   filter=transactionType:{SHIPPING_LABEL}
 * Requires scope: https://api.ebay.com/oauth/api_scope/sell.finances
 */

function financesRoot(): string {
    return process.env.EBAY_ENVIRONMENT?.trim() === 'PRODUCTION'
        ? 'https://apiz.ebay.com'
        : 'https://apiz.sandbox.ebay.com';
}

export type LabelCostResult = {
    byOrderId: Map<string, number>;
    error: string | null;
};

interface FinancesTransaction {
    orderId?: string;
    salesRecordReference?: string;
    transactionType?: string;
    bookingEntry?: string;
    amount?: { value?: string; currency?: string };
}

function signedAmount(tx: FinancesTransaction): number {
    const raw = parseFloat(tx.amount?.value || '');
    if (!Number.isFinite(raw)) return 0;
    return tx.bookingEntry === 'CREDIT' ? -raw : raw;
}

export async function fetchSellerLabelCosts(
    fromIso: string,
    toIso: string
): Promise<LabelCostResult> {
    const byOrderId = new Map<string, number>();
    let token: string;
    try {
        token = await getValidToken();
    } catch {
        return { byOrderId, error: 'EBAY_AUTH_REQUIRED' };
    }

    const limit = 200;
    let offset = 0;
    let total = Infinity;

    try {
        while (offset < total) {
            const params = new URLSearchParams();
            params.append('filter', 'transactionType:{SHIPPING_LABEL}');
            params.append('filter', `transactionDate:[${fromIso}..${toIso}]`);
            params.set('limit', String(limit));
            params.set('offset', String(offset));

            const res = await fetch(`${financesRoot()}/sell/finances/v1/transaction?${params}`, {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                    'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
                },
            });

            if (res.status === 204) break;

            if (res.status === 401 || res.status === 403) {
                const body = await res.text();
                console.error('[ebay-finances] auth/scope error:', res.status, body.slice(0, 500));
                return {
                    byOrderId,
                    error:
                        'Reconnect eBay at /ebay-connect to grant Finances access (needed for seller-paid label costs).',
                };
            }

            if (!res.ok) {
                const body = await res.text();
                console.error('[ebay-finances] getTransactions failed:', res.status, body.slice(0, 500));
                return { byOrderId, error: `Finances API ${res.status}` };
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
                const orderId = (tx.orderId || '').trim();
                if (!orderId || orderId === '0') continue;
                byOrderId.set(orderId, (byOrderId.get(orderId) ?? 0) + amt);
            }

            offset += txs.length;
            if (txs.length < limit) break;
        }
    } catch (err: any) {
        console.error('[ebay-finances] fetch error:', err);
        return { byOrderId, error: err.message || 'Finances fetch failed' };
    }

    return { byOrderId, error: null };
}
