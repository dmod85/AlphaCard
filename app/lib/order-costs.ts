// Combined-invoice cost split + stable order-head picking.
// Safe to import from client or server.

import { allocateProportionally } from './pool-roi';

export interface OrderCostLine {
    id: string;
    quantity_sold?: number | null;
    sold_for?: number | null;
    shipping_cost?: number | null;
    ebay_fee?: number | null;
    advertising_fee?: number | null;
}

export function lineCostWeight(line: OrderCostLine): number {
    const qty = Number(line.quantity_sold);
    if (Number.isFinite(qty) && qty > 0) return qty;
    const sold = Number(line.sold_for);
    if (Number.isFinite(sold) && sold > 0) return sold;
    return 1;
}

/**
 * Split order-level Finances amounts across line items.
 * Seller labels and ads are per-order; dumping them on the first row
 * makes that SKU eat postage for a 9-card invoice.
 *
 * Per-line FinalValueFee from GetOrders is left alone when present.
 */
export function patchesForOrderCosts(
    lines: OrderCostLine[],
    detail: {
        amount?: number | null;
        ebayFee?: number | null;
        adFee?: number | null;
        buyerShipping?: number | null;
    },
    opts: { onlyBlankShipping?: boolean } = {}
): Map<string, Record<string, number>> {
    const result = new Map<string, Record<string, number>>();
    if (lines.length === 0) return result;

    const touch = (id: string) => {
        let patch = result.get(id);
        if (!patch) {
            patch = {};
            result.set(id, patch);
        }
        return patch;
    };

    const weights = lines.map(lineCostWeight);

    if (detail.amount != null) {
        const alreadyFilled = lines.some((l) => l.shipping_cost != null);
        if (!(opts.onlyBlankShipping && alreadyFilled)) {
            const parts = allocateProportionally(detail.amount, weights);
            lines.forEach((line, i) => {
                touch(line.id).shipping_cost = parts[i] ?? 0;
            });
        }
    }

    if (detail.adFee != null) {
        const parts = allocateProportionally(detail.adFee, weights);
        lines.forEach((line, i) => {
            touch(line.id).advertising_fee = parts[i] ?? 0;
        });
    }

    if (detail.ebayFee != null && lines.every((l) => l.ebay_fee == null)) {
        const parts = allocateProportionally(detail.ebayFee, weights);
        lines.forEach((line, i) => {
            touch(line.id).ebay_fee = parts[i] ?? 0;
        });
    }

    if (detail.buyerShipping != null) {
        const parts = allocateProportionally(detail.buyerShipping, weights);
        lines.forEach((line, i) => {
            touch(line.id).order_shipping_cost = parts[i] ?? 0;
        });
    }

    return result;
}

export function pickOrderHeadId<
    T extends { id: string; shipping_cost?: number | null; sale_date?: string | null },
>(lines: T[]): string {
    const labeled = lines.filter((l) => l.shipping_cost != null && Number(l.shipping_cost) > 0);
    if (labeled.length === 1) return labeled[0].id;
    const sorted = [...lines].sort((a, b) => {
        const da = a.sale_date || '';
        const db = b.sale_date || '';
        if (da !== db) return da < db ? -1 : 1;
        return a.id < b.id ? -1 : 1;
    });
    return sorted[0]?.id ?? lines[0].id;
}

export function orderHeadIds<
    T extends {
        id: string;
        order_number: string;
        shipping_cost?: number | null;
        sale_date?: string | null;
    },
>(sales: T[]): Map<string, string> {
    const byOrder = new Map<string, T[]>();
    for (const s of sales) {
        const list = byOrder.get(s.order_number) ?? [];
        list.push(s);
        byOrder.set(s.order_number, list);
    }
    const heads = new Map<string, string>();
    Array.from(byOrder.entries()).forEach(([order, lines]) => {
        heads.set(order, pickOrderHeadId(lines));
    });
    return heads;
}

/** GetOrders copies the same buyer-paid postage onto every line of a combined invoice. */
export function ordersWithDuplicatedBuyerShipping<
    T extends { order_number: string; order_shipping_cost?: number | null },
>(sales: T[]): Set<string> {
    const byOrder = new Map<string, number[]>();
    for (const s of sales) {
        const list = byOrder.get(s.order_number) ?? [];
        list.push(Number(s.order_shipping_cost || 0));
        byOrder.set(s.order_number, list);
    }
    const dup = new Set<string>();
    Array.from(byOrder.entries()).forEach(([order, vals]) => {
        const positive = vals.filter((v: number) => v > 0);
        if (positive.length > 1 && positive.every((v: number) => v === positive[0])) dup.add(order);
    });
    return dup;
}
