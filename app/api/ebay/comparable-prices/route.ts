import { NextRequest, NextResponse } from 'next/server';

// eBay Finding API - searches active (Buy It Now) listings for price comparison.
// Docs: https://developer.ebay.com/devzone/finding/CallRef/findItemsByKeywords.html

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
}

function getFindingApiUrl(): string {
  const isProd = process.env.EBAY_ENVIRONMENT?.trim() === 'PRODUCTION';
  return isProd
    ? 'https://svcs.ebay.com/services/search/FindingService/v1'
    : 'https://svcs.sandbox.ebay.com/services/search/FindingService/v1';
}

function buildSearchQuery(title: string): string {
  const cleaned = title
    .replace(/\b(WOW|L@@K|LOOK|AMAZING|HOT|FIRE|FREE\s*SHIP(?:PING)?|FAST\s*SHIP(?:PING)?|MINT|NM|GEM)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return cleaned.split(/\s+/).slice(0, 8).join(' ');
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const title = searchParams.get('title');
  const itemId = searchParams.get('itemId') ?? '';

  if (!title) {
    return NextResponse.json({ error: 'Missing title parameter' }, { status: 400 });
  }

  const appId = process.env.EBAY_APP_ID?.trim();
  if (!appId) {
    return NextResponse.json({ error: 'Missing EBAY_APP_ID env var' }, { status: 500 });
  }

  const query = buildSearchQuery(title);

  const params = new URLSearchParams({
    'OPERATION-NAME': 'findItemsByKeywords',
    'SERVICE-VERSION': '1.0.0',
    'SECURITY-APPNAME': appId,
    'RESPONSE-DATA-FORMAT': 'JSON',
    'REST-PAYLOAD': '',
    keywords: query,
    'itemFilter(0).name': 'ListingType',
    'itemFilter(0).value': 'FixedPrice',
    'outputSelector(0)': 'PictureURLSuperSize',
    'paginationInput.entriesPerPage': '10',
    'paginationInput.pageNumber': '1',
    sortOrder: 'PricePlusShippingLowest',
  });

  try {
    const url = `${getFindingApiUrl()}?${params.toString()}`;
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
    });

    if (!res.ok) {
      const text = await res.text();
      console.error('[comparable-prices] Finding API error:', res.status, text);
      return NextResponse.json({ error: `eBay Finding API error: ${res.status}` }, { status: 500 });
    }

    const data = await res.json();
    const searchResult = data?.findItemsByKeywordsResponse?.[0]?.searchResult?.[0];
    const rawItems: any[] = searchResult?.item ?? [];

    const comparables: ComparableListing[] = [];

    for (const item of rawItems) {
      const id = item.itemId?.[0] ?? '';
      if (id === itemId) continue;

      const itemTitle = item.title?.[0] ?? '';
      const priceStr = item.sellingStatus?.[0]?.currentPrice?.[0]?.['__value__'] ?? '0';
      const price = parseFloat(priceStr);
      const itemUrl = item.viewItemURL?.[0] ?? '';
      const pictureUrl = item.galleryURL?.[0] ?? item.pictureURLSuperSize?.[0] ?? undefined;
      const condition = item.condition?.[0]?.conditionDisplayName?.[0] ?? undefined;

      if (price > 0) {
        comparables.push({ itemId: id, title: itemTitle, price, url: itemUrl, pictureUrl, condition });
      }
    }

    const prices = comparables.map(c => c.price).sort((a, b) => a - b);

    const result: ComparablePricesResult = {
      comparables,
      count: comparables.length,
      minPrice: prices.length > 0 ? prices[0] : null,
      maxPrice: prices.length > 0 ? prices[prices.length - 1] : null,
      avgPrice: prices.length > 0 ? prices.reduce((s, p) => s + p, 0) / prices.length : null,
      medianPrice: prices.length > 0 ? median(prices) : null,
    };

    return NextResponse.json(result);
  } catch (err: any) {
    console.error('[comparable-prices] Fetch error:', err);
    return NextResponse.json({ error: err.message || 'Failed to fetch comparable prices' }, { status: 500 });
  }
}