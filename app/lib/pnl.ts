// Shared P&L helpers — safe to import from client or server.

export const EXPENSE_CATEGORIES = ['advertising', 'supplies', 'shipping', 'ebay_fees', 'other'] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export interface PnlSettings {
    id: number;
    default_shipping_cost: number;
    default_supplies_cost: number;
    default_fee_rate: number;
    default_processing_fee: number;
    default_ad_rate: number;
}

export const DEFAULT_PNL_SETTINGS: PnlSettings = {
    id: 1,
    default_shipping_cost: 0.63,
    default_supplies_cost: 0,
    default_fee_rate: 0.1325,
    default_processing_fee: 0.3,
    default_ad_rate: 0,
};

export function roundMoney(n: number): number {
    return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function estimateEbayFee(soldFor: number, settings: PnlSettings): number {
    return roundMoney(Number(soldFor || 0) * settings.default_fee_rate + settings.default_processing_fee);
}

export function estimateAdFee(soldFor: number, settings: PnlSettings): number {
    if (!settings.default_ad_rate) return 0;
    return roundMoney(Number(soldFor || 0) * settings.default_ad_rate);
}

export interface SaleCostInput {
    sold_for: number;
    order_shipping_cost?: number | null;
    ebay_fee?: number | null;
    advertising_fee?: number | null;
    shipping_cost?: number | null;
    supplies_cost?: number | null;
}

export function resolvedSaleCosts(sale: SaleCostInput, settings: PnlSettings) {
    const soldFor = Number(sale.sold_for || 0);
    const buyerShipping = Number(sale.order_shipping_cost || 0);
    const feeBasis = soldFor + buyerShipping;
    const ebayFee = sale.ebay_fee != null ? Number(sale.ebay_fee) : estimateEbayFee(feeBasis, settings);
    const advertising = sale.advertising_fee != null ? Number(sale.advertising_fee) : estimateAdFee(feeBasis, settings);
    const shipping = sale.shipping_cost != null ? Number(sale.shipping_cost) : Number(settings.default_shipping_cost);
    const supplies = sale.supplies_cost != null ? Number(sale.supplies_cost) : Number(settings.default_supplies_cost);
    const saleCosts = roundMoney(ebayFee + advertising + shipping + supplies);
    // Buyer-paid shipping is revenue; seller-paid label is a cost (shipping).
    const net = roundMoney(soldFor + buyerShipping - saleCosts);
    return { ebayFee, advertising, shipping, supplies, saleCosts, net, soldFor, buyerShipping };
}

export function applyCostDefaultsToRow<T extends {
    sold_for: number;
    ebay_fee?: number | null;
    shipping_cost?: number | null;
    advertising_fee?: number | null;
    supplies_cost?: number | null;
}>(
    row: T,
    settings: PnlSettings
): T & {
    ebay_fee: number;
    advertising_fee: number;
    shipping_cost: number | null;
    supplies_cost: number;
} {
    return {
        ...row,
        ebay_fee: row.ebay_fee != null ? Number(row.ebay_fee) : estimateEbayFee(row.sold_for, settings),
        advertising_fee: row.advertising_fee != null ? Number(row.advertising_fee) : estimateAdFee(row.sold_for, settings),
        // Leave null when GetOrders has no postage yet so a later sync can backfill
        // the actual label cost after the seller buys a label.
        shipping_cost: row.shipping_cost != null ? Number(row.shipping_cost) : null,
        supplies_cost: row.supplies_cost != null ? Number(row.supplies_cost) : Number(settings.default_supplies_cost),
    };
}
