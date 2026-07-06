import { NextRequest, NextResponse } from 'next/server';
import { getValidToken } from '@/app/lib/ebay-auth';

// eBay Browse API - replaces the deprecated Finding API (shut down 2024).
// Docs: https://developer.ebay.com/api-docs/buy/browse/resources/item_summary/methods/search

interface ComparableListing {
  itemId: string;
  title: string;
  price: number;
  url: string;
  pictureUrl?: string;
  condition?: string;
}

interface ComparablePricesResult {
  comparables: ComparableListing[];
  minPrice: number | null;
  maxPrice: number | null;
  avgPrice: number | null;
  medianPrice: number | null;
  count: number;
  // Sold data & Hybrid Pricing Formula outputs
  medianSold: number | null;
  soldCount: number;
  suggestedLiquidityPrice: number | null;
  suggestedFairMarketPrice: number | null;
}

function getBrowseApiBaseUrl(): string {
  const isProd = process.env.EBAY_ENVIRONMENT?.trim() === 'PRODUCTION';
  return isProd
    ? 'https://api.ebay.com/buy/browse/v1'
    : 'https://api.sandbox.ebay.com/buy/browse/v1';
}

// Known brands for extraction
const KNOWN_BRANDS = [
  'Topps', 'Panini', 'Upper Deck', 'Bowman', 'Leaf', 'Fleer', 'Donruss', 'Score',
  'Stadium Club', 'Prizm', 'Select', 'Obsidian', 'Immaculate', 'National Treasures',
  'Finest', 'Chrome', 'Heritage', 'Allen & Ginter', 'Mosaic', 'Optic', 'Absolute',
  'Certified', 'Contenders', 'Classics', 'Flawless', 'Gold Standard', 'Spectra',
  'Revolution', 'Noir', 'Status', 'Elements', 'Inception', 'Majestic',
];

function buildSearchQuery(title: string): string {
  const cleaned = title
    .replace(/\b(WOW|L@@K|LOOK|AMAZING|HOT|FIRE|FREE\s*SHIP(?:PING)?|FAST\s*SHIP(?:PING)?|MINT|NM|GEM)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // 1. Extract year
  const year = cleaned.match(/\b(19|20)\d{2}\b/)?.[0];

  // 2. Extract brand (longest match wins to prefer e.g. "Stadium Club" over "Topps")
  let brand: string | undefined;
  let brandLen = 0;
  for (const b of KNOWN_BRANDS) {
    if (new RegExp(`\\b${b}\\b`, 'i').test(cleaned) && b.length > brandLen) {
      brand = b;
      brandLen = b.length;
    }
  }

  // 3. Extract league/sport acronym (UFC, MLB, NBA, NFL, NHL, FIFA, MLS, etc.)
  const league = cleaned.match(/\b(UFC|NBA|NFL|NHL|MLB|FIFA|MLS|NWSL|WNBA|WWE|XFL|USFL)\b/i)?.[0]?.toUpperCase();

  // 4. Extract player name and the subset/parallel name that follows it.
  //    Card titles follow the pattern: "#CARDNUM PlayerName Subset Name"
  //    e.g. "#SF-7 Tom Aspinall Special Forces"
  //    Player name = text immediately after the card number.
  //    Subset name = everything after the player name (up to 3 words).
  let playerName: string | undefined;
  let subsetName: string | undefined;
  const cardNumMatch = cleaned.match(/#[A-Z0-9-]+\s+([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){1,2})((?:\s+[A-Z][a-zA-Z'-]+){0,3})?/);
  if (cardNumMatch) {
    playerName = cardNumMatch[1];
    subsetName = cardNumMatch[2]?.trim() || undefined;
  } else {
    // Fallback: look for a run of 2-3 consecutive Title-Case words that aren't
    // a known brand, year, or league â€” likely the athlete name.
    const titleCaseRuns = Array.from(cleaned.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/g));
    for (const m of titleCaseRuns) {
      const candidate = m[1];
      const isKnownToken =
        (brand && candidate.toLowerCase().includes(brand.toLowerCase())) ||
        (league && candidate.toLowerCase().includes(league.toLowerCase())) ||
        /^\d{4}$/.test(candidate);
      if (!isKnownToken && candidate.split(' ').length >= 2) {
        playerName = candidate;
        break;
      }
    }
  }

  // 5. Build the query: year + brand + league + player name + subset name.
  //    Player name is the required anchor â€” subset name adds specificity but
  //    cannot be the sole match reason (eBay query terms are AND conditions,
  //    so results must satisfy both player AND subset).
  const parts: string[] = [];
  if (year) parts.push(year);
  if (brand) parts.push(brand);
  if (league) parts.push(league);
  if (playerName) parts.push(playerName);
  if (subsetName) parts.push(subsetName);

  // Fallback to first 8 words if we couldn't build a meaningful query
  if (parts.length < 2) {
    return cleaned.split(/\s+/).slice(0, 8).join(' ');
  }

  return parts.join(' ');
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Fetches sold listing prices via the eBay Marketplace Insights API.
 * buy.marketplace.insights is only granted in production — returns empty in sandbox.
 * Docs: https://developer.ebay.com/api-docs/buy/marketplace_insights/resources/item_summary/methods/search
 */
async function fetchSoldPrices(query: string, token: string): Promise<number[]> {
  const isProd = process.env.EBAY_ENVIRONMENT?.trim() === 'PRODUCTION';
  // Scope not available in sandbox — skip silently
  if (!isProd) return [];

  const baseUrl = 'https://api.ebay.com/buy/marketplace_insights/v1_beta';

  // Look back 90 days for a meaningful recent sold sample
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');

  const params = new URLSearchParams({
    q: query,
    filter: `lastSoldDate:[${ninetyDaysAgo}..]`,
    sort: 'lastSoldDate',
    limit: '10',
  });

  try {
    const res = await fetch(`${baseUrl}/item_summary/search?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error('[comparable-prices] Marketplace Insights API error:', res.status, text);
      return [];
    }

    const data = await res.json();
    const items: any[] = data?.itemSummaries ?? [];

    const prices = items
      .map((item: any) => parseFloat(item.lastSoldPrice?.value ?? '0'))
      .filter((p: number) => p > 0);

    console.log(`[comparable-prices] Sold prices for "${query}":`, prices);
    return prices;
  } catch (err) {
    console.error('[comparable-prices] Sold fetch error:', err);
    return [];
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const title = searchParams.get('title');
  const itemId = searchParams.get('itemId') ?? '';

  if (!title) {
    return NextResponse.json({ error: 'Missing title parameter' }, { status: 400 });
  }

  let token: string;
  try {
    token = await getValidToken();
  } catch {
    return NextResponse.json({ error: 'EBAY_AUTH_REQUIRED' }, { status: 401 });
  }

  const query = buildSearchQuery(title);

  const activeParams = new URLSearchParams({
    q: query,
    filter: 'buyingOptions:{FIXED_PRICE}',
    sort: 'price',
    limit: '10',
  });

  try {
    // Fetch active listings and sold listings in parallel â€” no added latency.
    const [activeRes, soldPricesRaw] = await Promise.all([
      fetch(`${getBrowseApiBaseUrl()}/item_summary/search?${activeParams.toString()}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
          'X-EBAY-C-ENDUSERCTX': 'affiliateCampaignId=<ePNCampaignId>,affiliateReferenceId=<referenceId>',
        },
      }),
      fetchSoldPrices(query, token),
    ]);

    if (!activeRes.ok) {
      const text = await activeRes.text();
      console.error('[comparable-prices] Browse API error:', activeRes.status, text);
      return NextResponse.json(
        { error: `eBay Browse API error: ${activeRes.status}` },
        { status: 500 }
      );
    }

    const data = await activeRes.json();
    const rawItems: any[] = data?.itemSummaries ?? [];

    const comparables: ComparableListing[] = [];

    for (const item of rawItems) {
      const id: string = item.itemId ?? '';
      if (id === itemId || id.endsWith(`|${itemId}`)) continue;

      const itemTitle: string = item.title ?? '';
      const priceStr: string = item.price?.value ?? '0';
      const price = parseFloat(priceStr);
      const itemUrl: string = item.itemWebUrl ?? '';
      const pictureUrl: string | undefined =
        item.thumbnailImages?.[0]?.imageUrl ??
        item.image?.imageUrl ??
        undefined;
      const condition: string | undefined = item.condition ?? undefined;

      if (price > 0) {
        comparables.push({ itemId: id, title: itemTitle, price, url: itemUrl, pictureUrl, condition });
      }
    }

    // Active listing price stats
    const prices = comparables.map(c => c.price).sort((a, b) => a - b);
    const minActive = prices.length > 0 ? prices[0] : null;
    const medianActive = prices.length > 0 ? median(prices) : null;

    // Sold listing price stats â€” use median to filter out one-off highs/lows
    const soldPrices = soldPricesRaw.sort((a, b) => a - b);
    const medianSold = soldPrices.length > 0 ? median(soldPrices) : null;

    // â”€â”€ Hybrid Pricing Formula â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Liquidity Formula: min(Median Sold, Min Active) - $0.01
    //   Guarantees cheapest option without severely undercutting market value.
    const suggestedLiquidityPrice =
      medianSold !== null && minActive !== null
        ? Math.max(0.01, parseFloat((Math.min(medianSold, minActive) - 0.01).toFixed(2)))
        : null;

    // Fair Market Formula: (Median Sold + Median Active) / 2
    //   Anchors price between proven buyer willingness and current market ask.
    const suggestedFairMarketPrice =
      medianSold !== null && medianActive !== null
        ? parseFloat(((medianSold + medianActive) / 2).toFixed(2))
        : null;

    const result: ComparablePricesResult = {
      comparables,
      count: comparables.length,
      minPrice: minActive,
      maxPrice: prices.length > 0 ? prices[prices.length - 1] : null,
      avgPrice: prices.length > 0 ? prices.reduce((s, p) => s + p, 0) / prices.length : null,
      medianPrice: medianActive,
      medianSold,
      soldCount: soldPrices.length,
      suggestedLiquidityPrice,
      suggestedFairMarketPrice,
    };

    return NextResponse.json(result);
  } catch (err: any) {
    console.error('[comparable-prices] Fetch error:', err);
    return NextResponse.json(
      { error: err.message || 'Failed to fetch comparable prices' },
      { status: 500 }
    );
  }
}