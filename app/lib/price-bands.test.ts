import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    classifyPriceBand,
    computePriceBandPool,
    saleShareOfBandCogs,
    usesPriceBands,
} from './price-bands';

test('usesPriceBands only on the pooled Sophie SKU', () => {
    assert.equal(usesPriceBands('Sophie_Lot'), true);
    assert.equal(usesPriceBands('Sophie-Lot-2026-08-16-PARTY'), false);
    assert.equal(usesPriceBands('WNBA_Lot'), false);
});

test('cuts: $4.99 base, $5 parallel, $12 hit', () => {
    assert.equal(classifyPriceBand(4.99).id, 'base');
    assert.equal(classifyPriceBand(5).id, 'mid');
    assert.equal(classifyPriceBand(11.99).id, 'mid');
    assert.equal(classifyPriceBand(12).id, 'hit');
    assert.equal(classifyPriceBand(55).id, 'hit');
});

test('qty-2 at $17.98 is $8.99 unit → parallel', () => {
    assert.equal(classifyPriceBand(17.98 / 2).id, 'mid');
});

test('cheap cards are capped so a hit keeps leftover basis', () => {
    const sales = [
        ...Array.from({ length: 80 }, () => ({ quantitySold: 1, soldFor: 3, net: 2.2 })),
        ...Array.from({ length: 40 }, () => ({ quantitySold: 1, soldFor: 7, net: 5 })),
        { quantitySold: 1, soldFor: 55, net: 38 },
    ];
    const m = computePriceBandPool(400, sales);
    const base = m.bands.find((b) => b.id === 'base')!;
    const mid = m.bands.find((b) => b.id === 'mid')!;
    const hit = m.bands.find((b) => b.id === 'hit')!;
    assert.equal(base.qty, 80);
    assert.ok(base.unitCost <= 1.75 + 1e-9);
    assert.ok(mid.unitCost <= 4.25 + 1e-9);
    assert.ok(hit.unitCost >= 8);
    assert.ok(hit.unitCost > mid.unitCost);
    assert.equal(Math.round((base.cost + mid.cost + hit.cost) * 100) / 100, 400);
});

test('no hits: leftover after caps stays remaining, not dumped on $3 cards', () => {
    const sales = Array.from({ length: 10 }, () => ({ quantitySold: 1, soldFor: 3, net: 2 }));
    const m = computePriceBandPool(100, sales);
    const base = m.bands.find((b) => b.id === 'base')!;
    assert.equal(base.cost, 17.5);
    assert.equal(m.remainingCost, 82.5);
    assert.equal(m.bands.find((b) => b.id === 'hit')!.qty, 0);
});

test('saleShareOfBandCogs uses the band unit, not the pool average', () => {
    const sales = [
        { quantitySold: 1, soldFor: 3, net: 2 },
        { quantitySold: 1, soldFor: 55, net: 38 },
    ];
    const m = computePriceBandPool(50, sales);
    const cheap = saleShareOfBandCogs(m, sales[0]);
    const party = saleShareOfBandCogs(m, sales[1]);
    assert.ok(party > cheap * 3);
    assert.equal(cheap, m.bands.find((b) => b.id === 'base')!.unitCost);
});
