// Pool cost allocation + realized / lot-to-date ROI.
// Safe to import from client or server.

import { roundMoney, roiPct } from './pnl';

export const ALLOCATION_MODES = ['equal', 'weighted', 'residual'] as const;
export type AllocationMode = (typeof ALLOCATION_MODES)[number];

export const POOL_ITEM_STATUSES = [
    'in_stock',
    'listed',
    'sold',
    'hold',
    'pc',
    'bulk_leftover',
] as const;
export type PoolItemStatus = (typeof POOL_ITEM_STATUSES)[number];

/** Cards that will be listed or sold (including a bulk dump). PC / hold are out. */
export const SELLABLE_STATUSES: ReadonlySet<PoolItemStatus> = new Set<PoolItemStatus>([
    'in_stock',
    'listed',
    'sold',
    'bulk_leftover',
]);

export const POOL_ITEM_STATUS_LABELS: Record<PoolItemStatus, string> = {
    in_stock: 'In Stock',
    listed: 'Listed',
    sold: 'Sold',
    hold: 'Hold',
    pc: 'PC',
    bulk_leftover: 'Bulk leftover',
};

export const ALLOCATION_MODE_LABELS: Record<AllocationMode, string> = {
    equal: 'Equal',
    weighted: 'Weighted',
    residual: 'Residual',
};

export const ROI_HELP = {
    realized:
        'Profit on cards sold so far, against those cards’ share of cost.',
    lotToDate:
        'All sales so far against the full buy. Green when the purchase is recouped.',
    sellableQty:
        'Cards you will sell from this pool — not pack count.',
} as const;

export function formatRoiPct(value: number | null, digits = 0): string {
    if (value == null || !Number.isFinite(value)) return '—';
    const sign = value > 0 ? '+' : '';
    return `${sign}${value.toFixed(digits)}%`;
}

export function roiToneClass(value: number | null): string {
    if (value == null) return 'text-gray-400';
    if (value > 0) return 'text-green-400';
    if (value < 0) return 'text-red-400';
    return 'text-gray-400';
}

export interface PoolLine {
    id?: string;
    label?: string | null;
    estimatedValue: number;
    allocatedCostOverride?: number | null;
    status: PoolItemStatus;
    qty: number;
}

export interface AllocatedLine extends PoolLine {
    allocatedCost: number;
    sellable: boolean;
}

export interface PoolInput {
    purchaseCost: number;
    sellableQty: number;
    soldQty: number;
    totalNetSales: number;
    allocationMode: AllocationMode;
    expectedBulkRecovery?: number;
    lines?: PoolLine[];
}

export interface PoolMetrics {
    purchaseCost: number;
    sellableQty: number;
    soldQty: number;
    totalNetSales: number;
    costOfSold: number;
    remainingCost: number;
    realizedProfit: number;
    realizedRoi: number | null;
    lotToDateRoi: number | null;
    recoveredPct: number | null;
    /** Average basis of one sellable card (hits, for residual). */
    unitCost: number | null;
    allocatedLines: AllocatedLine[];
    allocationMode: AllocationMode;
}

const BOX_RESIDUAL_HINT = /blaster|hobby|mega|retail|value/i;

export function isAllocationMode(v: unknown): v is AllocationMode {
    return typeof v === 'string' && (ALLOCATION_MODES as readonly string[]).includes(v);
}

export function isPoolItemStatus(v: unknown): v is PoolItemStatus {
    return typeof v === 'string' && (POOL_ITEM_STATUSES as readonly string[]).includes(v);
}

/** Boxes / blasters default to residual; purchased lots of similar singles stay equal. */
export function defaultAllocationMode(boxSize: string | null | undefined): AllocationMode {
    if (boxSize && BOX_RESIDUAL_HINT.test(boxSize)) return 'residual';
    return 'equal';
}

export function parseAllocationMode(v: unknown): AllocationMode {
    return isAllocationMode(v) ? v : 'equal';
}

export function parsePoolItemStatus(v: unknown): PoolItemStatus {
    return isPoolItemStatus(v) ? v : 'in_stock';
}

/**
 * Split `total` across `weights` so the parts sum exactly to `total`.
 * Last-penny drift lands on the item with the largest rounding remainder.
 */
export function allocateProportionally(total: number, weights: number[]): number[] {
    const n = weights.length;
    if (n === 0) return [];
    const money = roundMoney(total);
    const totalW = weights.reduce((s, w) => s + Number(w || 0), 0);
    if (!(totalW > 0)) {
        const unit = roundMoney(money / n);
        const parts = Array(n).fill(unit);
        parts[n - 1] = roundMoney(money - unit * (n - 1));
        return parts;
    }
    const raw = weights.map(w => (money * Number(w || 0)) / totalW);
    const rounded = raw.map(roundMoney);
    const drift = roundMoney(money - rounded.reduce((s, x) => s + x, 0));
    if (drift !== 0) {
        let idx = n - 1;
        let best = -1;
        for (let i = 0; i < n; i++) {
            const rem = Math.abs(raw[i] - rounded[i]);
            if (rem >= best) {
                best = rem;
                idx = i;
            }
        }
        rounded[idx] = roundMoney(rounded[idx] + drift);
    }
    return rounded;
}

function lineQty(line: PoolLine): number {
    const q = Number(line.qty);
    return Number.isFinite(q) && q > 0 ? q : 1;
}

function normalizeLine(line: PoolLine): PoolLine {
    return {
        ...line,
        estimatedValue: Number(line.estimatedValue) || 0,
        allocatedCostOverride:
            line.allocatedCostOverride == null || line.allocatedCostOverride === ('' as unknown)
                ? null
                : Number(line.allocatedCostOverride),
        status: parsePoolItemStatus(line.status),
        qty: lineQty(line),
    };
}

function isSellable(status: PoolItemStatus): boolean {
    return SELLABLE_STATUSES.has(status);
}

/**
 * Assign every line a basis so the pool sums to purchase_cost.
 * PC / hold get $0 unless the owner overrides.
 */
export function allocateLines(input: PoolInput): AllocatedLine[] {
    const purchaseCost = roundMoney(Number(input.purchaseCost) || 0);
    const mode = parseAllocationMode(input.allocationMode);
    const bulkRecovery = roundMoney(Math.max(Number(input.expectedBulkRecovery) || 0, 0));
    const lines = (input.lines ?? []).map(normalizeLine);
    if (lines.length === 0) return [];

    const result: AllocatedLine[] = lines.map(line => ({
        ...line,
        allocatedCost: 0,
        sellable: isSellable(line.status),
    }));

    if (
        mode === 'residual' &&
        bulkRecovery > 0 &&
        !result.some(l => l.status === 'bulk_leftover')
    ) {
        result.push({
            label: 'Bulk leftover',
            estimatedValue: bulkRecovery,
            status: 'bulk_leftover',
            qty: 1,
            allocatedCost: 0,
            sellable: true,
        });
    }

    const overrideIdx: number[] = [];
    let overrideSum = 0;
    result.forEach((line, i) => {
        if (line.allocatedCostOverride != null && Number.isFinite(line.allocatedCostOverride)) {
            overrideIdx.push(i);
            overrideSum += Number(line.allocatedCostOverride);
        }
    });
    overrideSum = roundMoney(overrideSum);

    const freeIdx = result
        .map((line, i) => ({ line, i }))
        .filter(({ line, i }) => !overrideIdx.includes(i) && line.sellable)
        .map(({ i }) => i);

    const leftover = roundMoney(purchaseCost - overrideSum);

    if (freeIdx.length === 0) {
        result.forEach((line, i) => {
            if (overrideIdx.includes(i)) {
                line.allocatedCost = roundMoney(Number(line.allocatedCostOverride));
            }
        });
        return result;
    }

    let parts: number[] = [];
    if (mode === 'residual') {
        const bulkFree = freeIdx.filter(i => result[i].status === 'bulk_leftover');
        const hitFree = freeIdx.filter(i => result[i].status !== 'bulk_leftover');
        const bulkOverride = result.reduce((s, line, i) => {
            if (line.status !== 'bulk_leftover' || !overrideIdx.includes(i)) return s;
            return s + line.allocatedCostOverride!;
        }, 0);
        const reservedBulk = roundMoney(
            Math.min(Math.max(bulkRecovery - bulkOverride, 0), Math.max(leftover, 0))
        );
        const hitMoney = roundMoney(leftover - reservedBulk);

        const hitWeights = hitFree.map(i => {
            const v = result[i].estimatedValue;
            return v > 0 ? v : lineQty(result[i]);
        });
        const hitParts = hitFree.length ? allocateProportionally(Math.max(hitMoney, 0), hitWeights) : [];
        const bulkParts = bulkFree.length
            ? allocateProportionally(Math.max(reservedBulk, 0), bulkFree.map(i => lineQty(result[i])))
            : [];

        parts = freeIdx.map(i => {
            const hi = hitFree.indexOf(i);
            if (hi >= 0) return hitParts[hi];
            const bi = bulkFree.indexOf(i);
            return bi >= 0 ? bulkParts[bi] : 0;
        });
    } else if (mode === 'weighted') {
        const weights = freeIdx.map(i => {
            const v = result[i].estimatedValue;
            return v > 0 ? v : lineQty(result[i]);
        });
        parts = allocateProportionally(Math.max(leftover, 0), weights);
    } else {
        const weights = freeIdx.map(i => lineQty(result[i]));
        parts = allocateProportionally(Math.max(leftover, 0), weights);
    }

    freeIdx.forEach((i, k) => {
        result[i].allocatedCost = parts[k] ?? 0;
    });
    overrideIdx.forEach(i => {
        result[i].allocatedCost = roundMoney(Number(result[i].allocatedCostOverride));
    });

    return result;
}

function syntheticUnitAndBulk(input: PoolInput): { hitUnit: number; hits: number; bulk: number; hitCost: number } {
    const purchaseCost = roundMoney(Number(input.purchaseCost) || 0);
    const hits = Math.max(Number(input.sellableQty) || 0, 0);
    const mode = parseAllocationMode(input.allocationMode);
    const bulk = mode === 'residual'
        ? roundMoney(Math.min(Math.max(Number(input.expectedBulkRecovery) || 0, 0), purchaseCost))
        : 0;
    const hitCost = roundMoney(purchaseCost - bulk);
    const hitUnit = hits > 0 ? hitCost / hits : 0;
    return { hitUnit, hits, bulk, hitCost };
}

function syntheticCostOfSold(input: PoolInput): number {
    const purchaseCost = roundMoney(Number(input.purchaseCost) || 0);
    const sold = Math.max(Number(input.soldQty) || 0, 0);
    if (sold <= 0) return 0;
    const { hitUnit, hits, bulk } = syntheticUnitAndBulk(input);
    if (hits <= 0) {
        return sold > 0 ? purchaseCost : 0;
    }
    const hitSold = Math.min(sold, hits);
    const extra = Math.max(sold - hits, 0);
    const bulkSold = extra > 0 ? bulk : 0;
    return roundMoney(Math.min(hitUnit * hitSold + bulkSold, purchaseCost));
}

function resolveSellableQty(input: PoolInput, lines: AllocatedLine[]): number {
    if (lines.length > 0) {
        const fromLines = lines.filter(l => l.sellable).reduce((s, l) => s + lineQty(l), 0);
        if (fromLines > 0) return fromLines;
    }
    return Math.max(Number(input.sellableQty) || 0, 0);
}

function computeCostOfSold(input: PoolInput, lines: AllocatedLine[]): number {
    const purchaseCost = roundMoney(Number(input.purchaseCost) || 0);
    const soldQty = Math.max(Number(input.soldQty) || 0, 0);
    if (soldQty <= 0) return 0;
    if (purchaseCost <= 0) return 0;

    if (lines.length === 0) {
        const { hits, bulk } = syntheticUnitAndBulk(input);
        if (hits > 0 && (soldQty > hits || (soldQty >= hits && bulk === 0))) {
            return purchaseCost;
        }
        return syntheticCostOfSold(input);
    }

    const soldLines = lines.filter(l => l.sellable && l.status === 'sold');
    const markedQty = soldLines.reduce((s, l) => s + lineQty(l), 0);
    const markedCost = soldLines.reduce((s, l) => s + l.allocatedCost, 0);

    const unmatched = Math.max(soldQty - markedQty, 0);
    if (unmatched <= 0) {
        const unsold = lines.filter(l => l.sellable && l.status !== 'sold');
        if (unsold.length === 0) return purchaseCost;
        return roundMoney(Math.min(markedCost, purchaseCost));
    }

    const unsoldSellable = lines.filter(l => l.sellable && l.status !== 'sold');
    const remainingQty = unsoldSellable.reduce((s, l) => s + lineQty(l), 0);
    if (remainingQty <= 0) return purchaseCost;

    const mode = parseAllocationMode(input.allocationMode);
    const unsoldHits = mode === 'residual'
        ? unsoldSellable.filter(l => l.status !== 'bulk_leftover')
        : unsoldSellable;
    const unsoldBulk = mode === 'residual'
        ? unsoldSellable.filter(l => l.status === 'bulk_leftover')
        : [];

    const hitQty = unsoldHits.reduce((s, l) => s + lineQty(l), 0);
    const hitBasis = unsoldHits.reduce((s, l) => s + l.allocatedCost, 0);
    const hitBurnQty = Math.min(unmatched, hitQty);
    const hitBurn = hitQty > 0 ? (hitBasis / hitQty) * hitBurnQty : 0;

    const extra = Math.max(unmatched - hitQty, 0);
    const bulkBasis = unsoldBulk.reduce((s, l) => s + l.allocatedCost, 0);
    const bulkBurn = extra > 0 ? bulkBasis : 0;

    if (hitBurnQty >= hitQty && (unsoldBulk.length === 0 || extra > 0)) {
        return purchaseCost;
    }
    return roundMoney(Math.min(markedCost + hitBurn + bulkBurn, purchaseCost));
}

export function computePoolMetrics(input: PoolInput): PoolMetrics {
    const purchaseCost = roundMoney(Number(input.purchaseCost) || 0);
    const soldQty = Math.max(Number(input.soldQty) || 0, 0);
    const totalNetSales = roundMoney(Number(input.totalNetSales) || 0);
    const allocationMode = parseAllocationMode(input.allocationMode);
    const allocatedLines = allocateLines(input);
    const sellableQty = resolveSellableQty(input, allocatedLines);
    const costOfSold = computeCostOfSold({ ...input, sellableQty, allocationMode }, allocatedLines);
    const remainingCost = roundMoney(Math.max(purchaseCost - costOfSold, 0));
    const realizedProfit = roundMoney(totalNetSales - costOfSold);
    const realizedRoi = roiPct(realizedProfit, costOfSold);
    const lotToDateRoi = roiPct(totalNetSales - purchaseCost, purchaseCost);
    const recoveredPct = purchaseCost > 0 ? (totalNetSales / purchaseCost) * 100 : null;

    let unitCost: number | null = null;
    if (allocatedLines.length > 0) {
        const sellable = allocatedLines.filter(l => l.sellable);
        const qty = sellable.reduce((s, l) => s + lineQty(l), 0);
        const basis = sellable.reduce((s, l) => s + l.allocatedCost, 0);
        unitCost = qty > 0 ? basis / qty : null;
    } else {
        const { hitUnit, hits } = syntheticUnitAndBulk({ ...input, sellableQty, allocationMode });
        unitCost = hits > 0 ? hitUnit : purchaseCost > 0 ? purchaseCost : null;
    }

    return {
        purchaseCost,
        sellableQty,
        soldQty,
        totalNetSales,
        costOfSold,
        remainingCost,
        realizedProfit,
        realizedRoi,
        lotToDateRoi,
        recoveredPct,
        unitCost,
        allocatedLines,
        allocationMode,
    };
}

/** This sale’s share of pool basis. Uses average of cost already sitting in cost_of_sold. */
export function saleShareOfPoolCogs(metrics: PoolMetrics, quantitySold: number): number {
    const qty = Math.max(Number(quantitySold) || 0, 0);
    if (qty <= 0) return 0;
    if (metrics.soldQty > 0 && metrics.costOfSold > 0) {
        return roundMoney((metrics.costOfSold / metrics.soldQty) * qty);
    }
    if (metrics.unitCost != null) return roundMoney(metrics.unitCost * qty);
    return 0;
}

export function sumAllocatedCost(lines: AllocatedLine[]): number {
    return roundMoney(lines.reduce((s, l) => s + l.allocatedCost, 0));
}

export interface PurchaseLike {
    cost: number;
    quantity: number;
    allocation_mode?: string | null;
    expected_bulk_recovery?: number | null;
    items?: Array<{
        id?: string;
        label?: string | null;
        estimated_value?: number | null;
        allocated_cost?: number | null;
        status?: string | null;
        qty?: number | null;
    }> | null;
}

export function linesFromPurchaseItems(items: PurchaseLike['items']): PoolLine[] {
    if (!items?.length) return [];
    return items.map(it => ({
        id: it.id,
        label: it.label ?? null,
        estimatedValue: Number(it.estimated_value) || 0,
        allocatedCostOverride: it.allocated_cost == null ? null : Number(it.allocated_cost),
        status: parsePoolItemStatus(it.status),
        qty: Number(it.qty) > 0 ? Number(it.qty) : 1,
    }));
}

/** One SKU / grouped parent: summed cost, summed sellable, same two ROIs. */
export function poolInputFromPurchases(
    purchases: PurchaseLike[],
    soldQty: number,
    totalNetSales: number
): PoolInput {
    const purchaseCost = purchases.reduce((s, p) => s + Number(p.cost || 0), 0);
    const sellableQty = purchases.reduce((s, p) => s + (Number(p.quantity) || 0), 0);
    const expectedBulkRecovery = purchases.reduce(
        (s, p) => s + (Number(p.expected_bulk_recovery) || 0),
        0
    );
    const modes = purchases.map(p => parseAllocationMode(p.allocation_mode));
    const allocationMode = modes.find(m => m !== 'equal') ?? modes[0] ?? 'equal';
    const lines = purchases.flatMap(p => linesFromPurchaseItems(p.items));
    return {
        purchaseCost,
        sellableQty,
        soldQty,
        totalNetSales,
        allocationMode,
        expectedBulkRecovery,
        lines,
    };
}
