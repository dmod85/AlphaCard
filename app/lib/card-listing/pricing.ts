import type { ActiveComp, PriceSuggestion, SoldComp } from './schema';

const RECENT_DAYS = 90;

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Drops prices outside 1.5×IQR once there are enough sales to tell. */
export function removeOutliers(prices: number[]): number[] {
  const sorted = [...prices].sort((a, b) => a - b);
  if (sorted.length < 4) return sorted;
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const fence = 1.5 * (q3 - q1);
  return sorted.filter(p => p >= q1 - fence && p <= q3 + fence);
}

/**
 * eBay-style price endings: $0.99 under $5, else whole dollars minus a cent
 * ($12.99). Never rounds below $0.99.
 */
export function charmPrice(value: number): number {
  if (value < 5) return Math.max(0.99, Math.round(value * 4) / 4 - 0.01);
  return Math.max(0.99, Math.round(value) - 0.01);
}

function isRecent(date: string | null, now: Date): boolean {
  if (!date) return true; // undated results came from a "recent sales" search
  const t = Date.parse(date);
  if (Number.isNaN(t)) return true;
  return now.getTime() - t <= RECENT_DAYS * 86_400_000;
}

/**
 * Suggests quick-sale / market / high prices. Sold comps drive it: exact
 * matches first, close matches only when there are fewer than 3 exact. With
 * no sold data it falls back to undercutting the cheapest active listings.
 */
export function suggestPrice(sold: SoldComp[], active: ActiveComp[], now = new Date()): PriceSuggestion {
  const recent = sold.filter(c => c.price > 0 && isRecent(c.sold_date, now));
  const exact = recent.filter(c => c.match === 'exact');
  const pool = exact.length >= 3 ? exact : recent;
  const prices = removeOutliers(pool.map(c => c.price));

  if (prices.length > 0) {
    const usedClose = pool !== exact && pool.some(c => c.match === 'close');
    const confidence: PriceSuggestion['confidence'] =
      exact.length >= 5 ? 'high' : exact.length >= 2 ? 'medium' : 'low';
    return {
      quick_sale: charmPrice(quantile(prices, 0.25)),
      suggested: charmPrice(quantile(prices, 0.5)),
      high: charmPrice(quantile(prices, 0.75)),
      confidence,
      basis: `Median of ${prices.length} recent sold comp${prices.length === 1 ? '' : 's'}` +
        (usedClose ? ' (includes close matches)' : ''),
    };
  }

  const activePrices = active.map(a => a.price).filter(p => p > 0).sort((a, b) => a - b);
  if (activePrices.length > 0) {
    const low = activePrices.slice(0, 3);
    const lowAvg = low.reduce((s, p) => s + p, 0) / low.length;
    return {
      quick_sale: charmPrice(activePrices[0] * 0.85),
      suggested: charmPrice(activePrices[0] * 0.95),
      high: charmPrice(lowAvg),
      confidence: 'low',
      basis: `No sold comps found; priced just under the cheapest of ${activePrices.length} active listing${activePrices.length === 1 ? '' : 's'}`,
    };
  }

  return { quick_sale: null, suggested: null, high: null, confidence: 'none', basis: 'No sold or active comps found' };
}

/**
 * Hard-caps a title at eBay's 80 characters on a word boundary so a long
 * model answer never gets rejected by AddItem.
 */
export function fitTitle(title: string, max = 80): string {
  const clean = title.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max + 1);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : clean.slice(0, max)).trim();
}
