import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    DEFAULT_PNL_SETTINGS,
    applyCostDefaultsToRow,
    looksLikeEstimatedAdFee,
    resolvedSaleCosts,
    roundMoney,
} from './pnl';

const settings = {
    ...DEFAULT_PNL_SETTINGS,
    default_shipping_cost: 0.78,
    default_supplies_cost: 0.27,
    default_ad_rate: 0.16,
};

test('resolvedSaleCosts does not invent ads or seller labels', () => {
    const c = resolvedSaleCosts({ sold_for: 17.98, order_shipping_cost: 2.5 }, settings);
    assert.equal(c.advertising, 0);
    assert.equal(c.shipping, 0);
    assert.equal(c.advertisingPending, true);
    assert.equal(c.shippingPending, true);
    assert.equal(c.supplies, 0.27);
    assert.ok(c.ebayFee > 0);
});

test('resolvedSaleCosts uses stored ads and labels when Finances posted them', () => {
    const c = resolvedSaleCosts(
        {
            sold_for: 17.98,
            order_shipping_cost: 2.5,
            advertising_fee: 1.2,
            shipping_cost: 1.07,
            ebay_fee: 2.57,
            supplies_cost: 0.27,
        },
        settings
    );
    assert.equal(c.advertising, 1.2);
    assert.equal(c.shipping, 1.07);
    assert.equal(c.advertisingPending, false);
    assert.equal(c.shippingPending, false);
    assert.equal(c.net, roundMoney(17.98 + 2.5 - 2.57 - 1.2 - 1.07 - 0.27));
});

test('applyCostDefaultsToRow leaves ads and shipping null', () => {
    const row = applyCostDefaultsToRow({ sold_for: 10 }, settings);
    assert.equal(row.advertising_fee, null);
    assert.equal(row.shipping_cost, null);
    assert.ok(row.ebay_fee > 0);
    assert.equal(row.supplies_cost, 0.27);
});

test('looksLikeEstimatedAdFee catches the old 16% bake-in', () => {
    assert.equal(looksLikeEstimatedAdFee(17.98, 2.88), true);
    assert.equal(looksLikeEstimatedAdFee(8.5, 1.36), true);
    assert.equal(looksLikeEstimatedAdFee(55, 38.15), false);
    assert.equal(looksLikeEstimatedAdFee(17.98, null), false);
    assert.equal(looksLikeEstimatedAdFee(10, 1.6, 2.5), true);
});
