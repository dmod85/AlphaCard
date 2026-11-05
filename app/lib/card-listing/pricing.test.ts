import assert from 'node:assert/strict';
import { test } from 'node:test';
import { charmPrice, fitTitle, removeOutliers, suggestPrice } from './pricing';
import type { SoldComp } from './schema';

const NOW = new Date('2026-10-30T00:00:00Z');

function comp(price: number, match: 'exact' | 'close' = 'exact', sold_date: string | null = '2026-10-15'): SoldComp {
  return { title: 't', price, sold_date, source: 'eBay', url: null, match };
}

test('charmPrice ends in .99 and never drops below $0.99', () => {
  assert.equal(charmPrice(12.4), 11.99);
  assert.equal(charmPrice(12.6), 12.99);
  assert.equal(charmPrice(3.1), 2.99);
  assert.equal(charmPrice(0.2), 0.99);
});

test('removeOutliers drops a single wild sale', () => {
  assert.deepEqual(removeOutliers([10, 11, 12, 13, 95]), [10, 11, 12, 13]);
  assert.deepEqual(removeOutliers([10, 95]), [10, 95]); // too few to judge
});

test('suggestPrice uses the median of exact sold comps', () => {
  const s = suggestPrice([comp(20), comp(22), comp(24), comp(26), comp(28)], [], NOW);
  assert.equal(s.suggested, 23.99);
  assert.equal(s.confidence, 'high');
  assert.ok(s.quick_sale! <= s.suggested! && s.suggested! <= s.high!);
});

test('close matches only count when exact ones are scarce', () => {
  const many = suggestPrice([comp(20), comp(20), comp(20), comp(100, 'close')], [], NOW);
  assert.equal(many.suggested, 19.99);
  const few = suggestPrice([comp(20), comp(30, 'close')], [], NOW);
  assert.match(few.basis, /close matches/);
  assert.equal(few.confidence, 'low');
});

test('sales older than 90 days are ignored', () => {
  const s = suggestPrice([comp(50, 'exact', '2026-01-01'), comp(10)], [], NOW);
  assert.equal(s.suggested, 9.99);
});

test('falls back to undercutting active listings with no sold data', () => {
  const s = suggestPrice([], [
    { title: 'a', price: 15, url: '', image_url: null },
    { title: 'b', price: 18, url: '', image_url: null },
  ], NOW);
  assert.equal(s.suggested, 13.99);
  assert.equal(s.confidence, 'low');
});

test('no data gives no price', () => {
  assert.equal(suggestPrice([], [], NOW).suggested, null);
});

test('fitTitle caps at 80 chars on a word boundary', () => {
  const long = '2023 Panini Prizm Silver Victor Wembanyama Rookie RC #136 San Antonio Spurs PSA 10 Gem Mint';
  const out = fitTitle(long);
  assert.ok(out.length <= 80);
  assert.ok(long.startsWith(out));
  assert.ok(!out.endsWith(' '));
  assert.equal(fitTitle('  short   title '), 'short title');
});
