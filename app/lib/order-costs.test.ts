import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    ordersWithDuplicatedBuyerShipping,
    patchesForOrderCosts,
    pickOrderHeadId,
} from './order-costs';

test('combined invoice splits the seller label by qty instead of dumping it on line 1', () => {
    const lines = [
        { id: 'a', quantity_sold: 1, sold_for: 1.61, shipping_cost: null, ebay_fee: 0.2, advertising_fee: null },
        { id: 'b', quantity_sold: 1, sold_for: 2.38, shipping_cost: null, ebay_fee: 0.29, advertising_fee: null },
        { id: 's', quantity_sold: 2, sold_for: 3.18, shipping_cost: null, ebay_fee: 0.79, advertising_fee: null },
    ];
    const patches = patchesForOrderCosts(lines, { amount: 11.25 });
    const ship = Array.from(patches.values()).reduce((s, p) => s + (p.shipping_cost ?? 0), 0);
    assert.equal(Math.round(ship * 100) / 100, 11.25);
    assert.equal(patches.get('s')!.shipping_cost, 5.63);
    assert.ok((patches.get('s')!.shipping_cost ?? 0) < 11.25);
    assert.equal(patches.get('s')!.ebay_fee, undefined);
});

test('onlyBlank shipping skips an order that already has a label', () => {
    const lines = [
        { id: 'a', quantity_sold: 1, shipping_cost: 1.07 },
        { id: 'b', quantity_sold: 1, shipping_cost: null },
    ];
    const patches = patchesForOrderCosts(lines, { amount: 2.14 }, { onlyBlankShipping: true });
    assert.equal(patches.size, 0);
});

test('ads from Finances split across lines; existing FVF is kept', () => {
    const lines = [
        { id: 'a', quantity_sold: 1, ebay_fee: 0.8, advertising_fee: 2.88 },
        { id: 'b', quantity_sold: 1, ebay_fee: 0.4, advertising_fee: null },
    ];
    const patches = patchesForOrderCosts(lines, { adFee: 1.5, ebayFee: 9.99 });
    assert.equal(patches.get('a')!.advertising_fee, 0.75);
    assert.equal(patches.get('b')!.advertising_fee, 0.75);
    assert.equal(patches.get('a')!.ebay_fee, undefined);
});

test('pickOrderHeadId prefers the line that already holds the label', () => {
    const head = pickOrderHeadId([
        { id: 'new', sale_date: '2026-09-12', shipping_cost: null },
        { id: 'old', sale_date: '2026-09-11', shipping_cost: 1.07 },
    ]);
    assert.equal(head, 'old');
});

test('duplicated GetOrders buyer shipping is detected', () => {
    const dup = ordersWithDuplicatedBuyerShipping([
        { order_number: '1', order_shipping_cost: 2.5 },
        { order_number: '1', order_shipping_cost: 2.5 },
        { order_number: '2', order_shipping_cost: 1.25 },
        { order_number: '2', order_shipping_cost: 0 },
    ]);
    assert.equal(dup.has('1'), true);
    assert.equal(dup.has('2'), false);
});
