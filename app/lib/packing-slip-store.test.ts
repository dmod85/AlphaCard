import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SlipSaleRow } from './packing-slip-store';

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://x.supabase.co';
process.env.SUPABASE_SERVICE_KEY ??= 'x';

async function loadBuildSlipOrder() {
    const { buildSlipOrder } = await import('./packing-slip-store');
    return buildSlipOrder;
}

function row(overrides: Partial<SlipSaleRow> = {}): SlipSaleRow {
    return {
        order_number: '86-15472-64588',
        sales_record_number: '12345',
        sale_date: '2026-11-20',
        buyer: 'chippr10jones',
        ship_to_name: 'Jane Doe',
        ship_to_street1: '1 Main St',
        ship_to_street2: 'Apt 2',
        ship_to_city: 'Indianapolis',
        ship_to_state: 'IN',
        ship_to_zip: '46201',
        ship_to_country: 'US',
        shipping_service: 'USPS Ground Advantage',
        order_subtotal: 10.5,
        order_shipping_cost: 1.49,
        order_tax: 0,
        order_total: 11.99,
        item_title: '2024 Travis Kelce',
        sku: 'Kelce_Lot',
        ebay_item_id: '111',
        quantity_sold: 1,
        sold_for: 10.5,
        picture_url: 'https://example.com/kelce.jpg',
        ...overrides,
    };
}

test('maps a single ebay_sales row onto PackingSlipOrder', async () => {
    const buildSlipOrder = await loadBuildSlipOrder();
    const order = buildSlipOrder([row()], { storeName: 'AlphaCard', storeUrl: 'https://example.com' });
    assert.equal(order.orderNumber, '86-15472-64588');
    assert.equal(order.salesRecordNumber, '12345');
    assert.equal(order.saleDate, '2026-11-20');
    assert.equal(order.buyer, 'chippr10jones');
    assert.deepEqual(order.shipTo, {
        name: 'Jane Doe',
        street1: '1 Main St',
        street2: 'Apt 2',
        city: 'Indianapolis',
        state: 'IN',
        zip: '46201',
        country: 'US',
    });
    assert.equal(order.shippingService, 'USPS Ground Advantage');
    assert.equal(order.subtotal, 10.5);
    assert.equal(order.shippingCost, 1.49);
    assert.equal(order.tax, 0);
    assert.equal(order.total, 11.99);
    assert.deepEqual(order.items, [{
        title: '2024 Travis Kelce',
        sku: 'Kelce_Lot',
        ebayItemId: '111',
        quantity: 1,
        soldFor: 10.5,
        pictureUrl: 'https://example.com/kelce.jpg',
    }]);
    assert.equal(order.storeName, 'AlphaCard');
    assert.equal(order.storeUrl, 'https://example.com');
});

test('uses the first row for order-level fields and maps every row as an item', async () => {
    const buildSlipOrder = await loadBuildSlipOrder();
    const order = buildSlipOrder([
        row({ item_title: 'Kelce', sku: 'A', ebay_item_id: '1', quantity_sold: 1, sold_for: 10, picture_url: null, order_total: 25 }),
        row({ item_title: 'Mahomes', sku: 'B', ebay_item_id: '2', quantity_sold: 2, sold_for: 15, picture_url: 'https://example.com/m.jpg', order_total: 99 }),
    ], { storeName: 'Store' });

    assert.equal(order.total, 25);
    assert.equal(order.items.length, 2);
    assert.deepEqual(order.items[0], {
        title: 'Kelce',
        sku: 'A',
        ebayItemId: '1',
        quantity: 1,
        soldFor: 10,
        pictureUrl: null,
    });
    assert.deepEqual(order.items[1], {
        title: 'Mahomes',
        sku: 'B',
        ebayItemId: '2',
        quantity: 2,
        soldFor: 15,
        pictureUrl: 'https://example.com/m.jpg',
    });
});

test('defaults storeName to Packing Slip and storeUrl to null', async () => {
    const buildSlipOrder = await loadBuildSlipOrder();
    const order = buildSlipOrder([row()], { storeName: '  ', storeUrl: '' });
    assert.equal(order.storeName, 'Packing Slip');
    assert.equal(order.storeUrl, null);
});

test('trims store name and url', async () => {
    const buildSlipOrder = await loadBuildSlipOrder();
    const order = buildSlipOrder([row()], { storeName: '  Alpha Card  ', storeUrl: '  https://store.example  ' });
    assert.equal(order.storeName, 'Alpha Card');
    assert.equal(order.storeUrl, 'https://store.example');
});

test('throws when there are no rows', async () => {
    const buildSlipOrder = await loadBuildSlipOrder();
    assert.throws(() => buildSlipOrder([]), /No sales rows to build a packing slip/);
});
