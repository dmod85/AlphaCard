import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    allocateLines,
    allocateProportionally,
    computePoolMetrics,
    defaultAllocationMode,
    poolInputFromPurchases,
    saleShareOfPoolCogs,
    sumAllocatedCost,
    type PoolInput,
} from './pool-roi';

function nearly(actual: number, expected: number, digits = 2) {
    const factor = 10 ** digits;
    assert.equal(Math.round(actual * factor) / factor, Math.round(expected * factor) / factor);
}

test('equal pool: two similar lots lumped, four sales', () => {
    const m = computePoolMetrics({
        purchaseCost: 30,
        sellableQty: 15,
        soldQty: 4,
        totalNetSales: 18.32,
        allocationMode: 'equal',
    });
    nearly(m.unitCost ?? 0, 2);
    nearly(m.costOfSold, 8);
    nearly(m.realizedProfit, 10.32);
    nearly(m.realizedRoi ?? 0, 129);
    nearly(m.remainingCost, 22);
    nearly(m.sellableQty - m.soldQty, 11);
    // Brief arithmetic note: (18.32 − 30) / 30 = −38.9%, not the “+34%”
    // that appeared in the discussion (that was realized profit / full buy).
    nearly(m.lotToDateRoi ?? 0, -38.93, 2);
    nearly(m.recoveredPct ?? 0, 61.07, 2);
});

test('grouped parent SKU sums cost and sellable, same two ROIs', () => {
    const input = poolInputFromPurchases(
        [
            { cost: 20, quantity: 10, allocation_mode: 'equal' },
            { cost: 10, quantity: 5, allocation_mode: 'equal' },
        ],
        4,
        18.32
    );
    nearly(input.purchaseCost, 30);
    nearly(input.sellableQty, 15);
    const m = computePoolMetrics(input);
    nearly(m.costOfSold, 8);
    nearly(m.realizedRoi ?? 0, 129);
    nearly(m.lotToDateRoi ?? 0, -38.93, 2);
});

test('weighted 3-card lot splits $30 by $50 / $5 / $5', () => {
    const input: PoolInput = {
        purchaseCost: 30,
        sellableQty: 3,
        soldQty: 0,
        totalNetSales: 0,
        allocationMode: 'weighted',
        lines: [
            { estimatedValue: 50, status: 'in_stock', qty: 1, label: 'hit' },
            { estimatedValue: 5, status: 'in_stock', qty: 1, label: 'small-a' },
            { estimatedValue: 5, status: 'in_stock', qty: 1, label: 'small-b' },
        ],
    };
    const lines = allocateLines(input);
    nearly(sumAllocatedCost(lines), 30);
    nearly(lines[0].allocatedCost, 25);
    nearly(lines[1].allocatedCost, 2.5);
    nearly(lines[2].allocatedCost, 2.5);
});

test('residual box: two listers + $10 bulk', () => {
    const input: PoolInput = {
        purchaseCost: 80,
        sellableQty: 2,
        soldQty: 0,
        totalNetSales: 0,
        allocationMode: 'residual',
        expectedBulkRecovery: 10,
        lines: [
            { estimatedValue: 50, status: 'listed', qty: 1, label: 'hit-a' },
            { estimatedValue: 20, status: 'listed', qty: 1, label: 'hit-b' },
            { estimatedValue: 10, status: 'bulk_leftover', qty: 1, label: 'bulk' },
        ],
    };
    const lines = allocateLines(input);
    nearly(sumAllocatedCost(lines), 80);
    nearly(lines[0].allocatedCost, 50);
    nearly(lines[1].allocatedCost, 20);
    nearly(lines[2].allocatedCost, 10);
});

test('residual box with bulk never sold: hits share full $80 by value', () => {
    const input: PoolInput = {
        purchaseCost: 80,
        sellableQty: 2,
        soldQty: 0,
        totalNetSales: 0,
        allocationMode: 'residual',
        expectedBulkRecovery: 0,
        lines: [
            { estimatedValue: 50, status: 'listed', qty: 1 },
            { estimatedValue: 20, status: 'listed', qty: 1 },
        ],
    };
    const lines = allocateLines(input);
    nearly(sumAllocatedCost(lines), 80);
    nearly(lines[0].allocatedCost, 57.14);
    nearly(lines[1].allocatedCost, 22.86);
});

test('residual without line items: hits equal-split cost minus bulk', () => {
    const oneHit = computePoolMetrics({
        purchaseCost: 80,
        sellableQty: 2,
        soldQty: 1,
        totalNetSales: 40,
        allocationMode: 'residual',
        expectedBulkRecovery: 10,
    });
    nearly(oneHit.costOfSold, 35);
    nearly(oneHit.remainingCost, 45);
    nearly(oneHit.unitCost ?? 0, 35);
    const bothHits = computePoolMetrics({
        purchaseCost: 80,
        sellableQty: 2,
        soldQty: 2,
        totalNetSales: 70,
        allocationMode: 'residual',
        expectedBulkRecovery: 10,
    });
    nearly(bothHits.costOfSold, 70);
    nearly(bothHits.remainingCost, 10);
    const closed = computePoolMetrics({
        purchaseCost: 80,
        sellableQty: 2,
        soldQty: 3,
        totalNetSales: 78,
        allocationMode: 'residual',
        expectedBulkRecovery: 10,
    });
    nearly(closed.costOfSold, 80);
    nearly(closed.remainingCost, 0);
});

test('closed pool: lot-to-date equals realized (Sophie-style)', () => {
    const m = computePoolMetrics({
        purchaseCost: 489.97,
        sellableQty: 102,
        soldQty: 102,
        totalNetSales: 594.03,
        allocationMode: 'equal',
    });
    nearly(m.costOfSold, 489.97);
    nearly(m.remainingCost, 0);
    nearly(m.realizedRoi ?? 0, m.lotToDateRoi ?? 0);
    nearly(m.lotToDateRoi ?? 0, 21.24, 2);
});

test('ripped blaster: 1 sold of pack-count 28 stays deeply negative lot-to-date; realized uses the one card', () => {
    const packCount = computePoolMetrics({
        purchaseCost: 29.99,
        sellableQty: 28,
        soldQty: 1,
        totalNetSales: 2,
        allocationMode: 'equal',
    });
    nearly(packCount.lotToDateRoi ?? 0, -93.33, 2);
    nearly(packCount.costOfSold, 29.99 / 28);

    const listedOnly = computePoolMetrics({
        purchaseCost: 29.99,
        sellableQty: 1,
        soldQty: 1,
        totalNetSales: 2,
        allocationMode: 'residual',
        expectedBulkRecovery: 0,
    });
    nearly(listedOnly.costOfSold, 29.99);
    nearly(listedOnly.lotToDateRoi ?? 0, -93.33, 2);
    nearly(listedOnly.realizedRoi ?? 0, (2 - 29.99) / 29.99 * 100, 2);
});

test('changing sellable qty does not change sales or purchase cost', () => {
    const sales = 41.74;
    const cost = 131.77;
    const a = computePoolMetrics({
        purchaseCost: cost,
        sellableQty: 72,
        soldQty: 9,
        totalNetSales: sales,
        allocationMode: 'equal',
    });
    const b = computePoolMetrics({
        purchaseCost: cost,
        sellableQty: 12,
        soldQty: 9,
        totalNetSales: sales,
        allocationMode: 'equal',
    });
    nearly(a.purchaseCost, b.purchaseCost);
    nearly(a.totalNetSales, b.totalNetSales);
    nearly(a.lotToDateRoi ?? 0, b.lotToDateRoi ?? 0);
    nearly(a.lotToDateRoi ?? 0, -68.32, 2);
    assert.notEqual(Math.round(a.costOfSold * 100), Math.round(b.costOfSold * 100));
    nearly(b.costOfSold, (131.77 / 12) * 9);
});

test('PC cards do not sit in sellable qty and get $0 basis unless overridden', () => {
    const lines = allocateLines({
        purchaseCost: 30,
        sellableQty: 2,
        soldQty: 0,
        totalNetSales: 0,
        allocationMode: 'equal',
        lines: [
            { estimatedValue: 20, status: 'in_stock', qty: 1 },
            { estimatedValue: 20, status: 'in_stock', qty: 1 },
            { estimatedValue: 100, status: 'pc', qty: 1 },
        ],
    });
    nearly(lines[0].allocatedCost, 15);
    nearly(lines[1].allocatedCost, 15);
    nearly(lines[2].allocatedCost, 0);
    nearly(sumAllocatedCost(lines), 30);
    const m = computePoolMetrics({
        purchaseCost: 30,
        sellableQty: 99,
        soldQty: 0,
        totalNetSales: 0,
        allocationMode: 'equal',
        lines,
    });
    assert.equal(m.sellableQty, 2);
});

test('sold line items use their allocated cost, not equal-split of the pool', () => {
    const m = computePoolMetrics({
        purchaseCost: 30,
        sellableQty: 3,
        soldQty: 1,
        totalNetSales: 40,
        allocationMode: 'weighted',
        lines: [
            { estimatedValue: 50, status: 'sold', qty: 1 },
            { estimatedValue: 5, status: 'in_stock', qty: 1 },
            { estimatedValue: 5, status: 'in_stock', qty: 1 },
        ],
    });
    nearly(m.costOfSold, 25);
    nearly(m.remainingCost, 5);
    nearly(m.realizedProfit, 15);
    nearly(m.realizedRoi ?? 0, 60);
});

test('unmatched sales on a weighted pool burn remaining average basis', () => {
    const m = computePoolMetrics({
        purchaseCost: 30,
        sellableQty: 3,
        soldQty: 1,
        totalNetSales: 6,
        allocationMode: 'weighted',
        lines: [
            { estimatedValue: 50, status: 'in_stock', qty: 1 },
            { estimatedValue: 5, status: 'in_stock', qty: 1 },
            { estimatedValue: 5, status: 'in_stock', qty: 1 },
        ],
    });
    nearly(m.costOfSold, 10);
    nearly(m.remainingCost, 20);
});

test('overrides plus free lines still sum to purchase cost', () => {
    const lines = allocateLines({
        purchaseCost: 80,
        sellableQty: 3,
        soldQty: 0,
        totalNetSales: 0,
        allocationMode: 'residual',
        expectedBulkRecovery: 10,
        lines: [
            { estimatedValue: 50, status: 'listed', qty: 1, allocatedCostOverride: 40 },
            { estimatedValue: 20, status: 'listed', qty: 1 },
            { estimatedValue: 10, status: 'bulk_leftover', qty: 1 },
        ],
    });
    nearly(sumAllocatedCost(lines), 80);
    nearly(lines[0].allocatedCost, 40);
    nearly(lines[2].allocatedCost, 10);
    nearly(lines[1].allocatedCost, 30);
});

test('allocateProportionally last-penny sums exactly', () => {
    const parts = allocateProportionally(10, [1, 1, 1]);
    nearly(parts.reduce((s, n) => s + n, 0), 10);
    assert.equal(parts.length, 3);
});

test('box size defaults: lots equal, blasters residual', () => {
    assert.equal(defaultAllocationMode('Lot'), 'equal');
    assert.equal(defaultAllocationMode('Blaster'), 'residual');
    assert.equal(defaultAllocationMode('Hobby'), 'residual');
    assert.equal(defaultAllocationMode('Mega'), 'residual');
    assert.equal(defaultAllocationMode('Value x 3'), 'residual');
    assert.equal(defaultAllocationMode(null), 'equal');
});

test('saleShareOfPoolCogs uses average of cost of sold', () => {
    const m = computePoolMetrics({
        purchaseCost: 30,
        sellableQty: 15,
        soldQty: 4,
        totalNetSales: 18.32,
        allocationMode: 'equal',
    });
    nearly(saleShareOfPoolCogs(m, 1), 2);
    nearly(saleShareOfPoolCogs(m, 2), 4);
});

test('residual hit lines without a bulk row still reserve bulk recovery', () => {
    const lines = allocateLines({
        purchaseCost: 80,
        sellableQty: 2,
        soldQty: 0,
        totalNetSales: 0,
        allocationMode: 'residual',
        expectedBulkRecovery: 10,
        lines: [
            { estimatedValue: 50, status: 'listed', qty: 1 },
            { estimatedValue: 20, status: 'listed', qty: 1 },
        ],
    });
    nearly(sumAllocatedCost(lines), 80);
    nearly(lines[0].allocatedCost, 50);
    nearly(lines[1].allocatedCost, 20);
    nearly(lines[2].allocatedCost, 10);
    assert.equal(lines[2].status, 'bulk_leftover');

    const oneSold = computePoolMetrics({
        purchaseCost: 80,
        sellableQty: 2,
        soldQty: 1,
        totalNetSales: 40,
        allocationMode: 'residual',
        expectedBulkRecovery: 10,
        lines: [
            { estimatedValue: 50, status: 'listed', qty: 1 },
            { estimatedValue: 20, status: 'listed', qty: 1 },
        ],
    });
    nearly(oneSold.costOfSold, 35);
    nearly(oneSold.remainingCost, 45);
});

test('realized ROI is blank when nothing has sold', () => {
    const m = computePoolMetrics({
        purchaseCost: 80,
        sellableQty: 2,
        soldQty: 0,
        totalNetSales: 0,
        allocationMode: 'residual',
        expectedBulkRecovery: 10,
    });
    assert.equal(m.realizedRoi, null);
    assert.equal(m.costOfSold, 0);
    nearly(m.lotToDateRoi ?? 0, -100);
    nearly(m.remainingCost, 80);
});
