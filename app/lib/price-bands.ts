// Automatic Sophie_Lot buckets from sold-for. Cheap cards get a cost cap;
// leftover basis sits on hits so every band does not show the same ROI%.
//
// Cuts from 193 Sophie unit sales (incl. hits on other SKUs):
//   p50 $4.99, p75 $6.99, p90 $9.99, p95 $11.99, tail $13–$80.

import { roundMoney, roiPct } from './pnl';

export type PriceBandId = 'base' | 'mid' | 'hit';

export interface PriceBandDef {
    id: PriceBandId;
    label: string;
    hint: string;
    /** Inclusive lower bound (unit sold-for). */
    min: number;
    /** Exclusive upper bound. Infinity for the top band. */
    max: number;
    /** Max basis per card. Null = residual (gets leftover). */
    costCap: number | null;
    /** Floor basis per card when this band is residual. */
    minUnitCost?: number;
}

export const SOPHIE_PRICE_BANDS: readonly PriceBandDef[] = [
    { id: 'base', label: 'Base', hint: 'under $5', min: 0, max: 5, costCap: 1.75 },
    { id: 'mid', label: 'Parallel', hint: '$5–$12', min: 5, max: 12, costCap: 4.25 },
    { id: 'hit', label: 'Hit', hint: '$12+', min: 12, max: Infinity, costCap: null, minUnitCost: 8 },
] as const;

export function usesPriceBands(sku: string | null | undefined): boolean {
    return /^Sophie_Lot$/i.test(String(sku || '').trim());
}

export function classifyPriceBand(unitSoldFor: number): PriceBandDef {
    const u = Number(unitSoldFor);
    const price = Number.isFinite(u) && u > 0 ? u : 0;
    return SOPHIE_PRICE_BANDS.find((b) => price >= b.min && price < b.max) ?? SOPHIE_PRICE_BANDS[0];
}

export interface BandSale {
    quantitySold: number;
    soldFor: number;
    net: number;
}

export interface BandMetrics {
    id: PriceBandId;
    label: string;
    hint: string;
    qty: number;
    net: number;
    soldFor: number;
    cost: number;
    unitCost: number;
    realizedProfit: number;
    realizedRoi: number | null;
}

export interface PriceBandPool {
    purchaseCost: number;
    soldQty: number;
    totalNet: number;
    costOfSold: number;
    remainingCost: number;
    bands: BandMetrics[];
    closed: boolean;
}

export function unitSoldFor(sale: BandSale): number {
    const qty = Math.max(Number(sale.quantitySold) || 1, 1);
    return (Number(sale.soldFor) || 0) / qty;
}

/**
 * Waterfall: base and parallel take up to their per-card cap; hits take
 * leftover (at least minUnitCost when there is money). If caps exceed the
 * buy, mid is cut first, then base — hits keep their floor.
 */
export function computePriceBandPool(purchaseCost: number, sales: BandSale[]): PriceBandPool {
    const P = roundMoney(Math.max(Number(purchaseCost) || 0, 0));
    const tallies: Record<PriceBandId, { qty: number; net: number; soldFor: number }> = {
        base: { qty: 0, net: 0, soldFor: 0 },
        mid: { qty: 0, net: 0, soldFor: 0 },
        hit: { qty: 0, net: 0, soldFor: 0 },
    };
    let soldQty = 0;
    let totalNet = 0;
    for (const s of sales) {
        const qty = Math.max(Number(s.quantitySold) || 1, 1);
        const band = classifyPriceBand(unitSoldFor(s));
        tallies[band.id].qty += qty;
        tallies[band.id].net += Number(s.net) || 0;
        tallies[band.id].soldFor += Number(s.soldFor) || 0;
        soldQty += qty;
        totalNet += Number(s.net) || 0;
    }
    Object.values(tallies).forEach((t) => {
        t.net = roundMoney(t.net);
        t.soldFor = roundMoney(t.soldFor);
    });

    const baseDef = SOPHIE_PRICE_BANDS[0];
    const midDef = SOPHIE_PRICE_BANDS[1];
    const hitDef = SOPHIE_PRICE_BANDS[2];
    const baseNeed = roundMoney((baseDef.costCap ?? 0) * tallies.base.qty);
    const midNeed = roundMoney((midDef.costCap ?? 0) * tallies.mid.qty);
    const hitFloor = roundMoney((hitDef.minUnitCost ?? 0) * tallies.hit.qty);

    let hitCost = 0;
    let baseCost = 0;
    let midCost = 0;
    let remaining = P;

    const take = (want: number) => {
        const got = roundMoney(Math.min(Math.max(want, 0), remaining));
        remaining = roundMoney(remaining - got);
        return got;
    };

    hitCost = take(hitFloor);
    baseCost = take(baseNeed);
    midCost = take(midNeed);
    if (tallies.hit.qty > 0) {
        hitCost = roundMoney(hitCost + take(remaining));
    }

    const costOf = { base: baseCost, mid: midCost, hit: hitCost };
    const costOfSold = roundMoney(baseCost + midCost + hitCost);
    const remainingCost = roundMoney(Math.max(P - costOfSold, 0));

    const bands: BandMetrics[] = SOPHIE_PRICE_BANDS.map((def) => {
        const t = tallies[def.id];
        const cost = costOf[def.id];
        const unitCost = t.qty > 0 ? roundMoney(cost / t.qty) : 0;
        const realizedProfit = roundMoney(t.net - cost);
        return {
            id: def.id,
            label: def.label,
            hint: def.hint,
            qty: t.qty,
            net: t.net,
            soldFor: t.soldFor,
            cost,
            unitCost,
            realizedProfit,
            realizedRoi: t.qty > 0 && cost > 0 ? roiPct(realizedProfit, cost) : t.qty > 0 ? null : null,
        };
    });

    return {
        purchaseCost: P,
        soldQty,
        totalNet: roundMoney(totalNet),
        costOfSold,
        remainingCost,
        bands,
        closed: remainingCost <= 0 && soldQty > 0,
    };
}

export function saleShareOfBandCogs(pool: PriceBandPool, sale: BandSale): number {
    const qty = Math.max(Number(sale.quantitySold) || 1, 1);
    const band = classifyPriceBand(unitSoldFor(sale));
    const metrics = pool.bands.find((b) => b.id === band.id);
    if (!metrics || metrics.qty <= 0) return 0;
    return roundMoney(metrics.unitCost * qty);
}

export const PRICE_BAND_TONE: Record<PriceBandId, string> = {
    base: 'text-gray-300 bg-gray-700/80',
    mid: 'text-sky-300 bg-sky-500/15',
    hit: 'text-amber-300 bg-amber-500/15',
};
