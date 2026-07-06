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
}

function getBrowseApiBaseUrl(): string {
  const isProd = process.env.EBAY_ENVIRONMENT?.trim() === 'PRODUCTION';
  return isProd
    ? 'https://api.ebay.com/buy/browse/v1'
    : 'https://api.sandbox.ebay.com/buy/browse/v1';
}

function buildSearchQuery(title: string): string {
  const cleaned = title
    .replace(/\b(WOW|L@@K|LOOK|AMAZING|HOT|FIRE|FREE\s*SHIP(?:PING)?|FAST\s*SHIP(?:PING)?|MINT|NM|GEM)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  // Use first 8 words for a focused query
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

  let token: string;
  try {
    token = await getValidToken();
  } catch {
    return NextResponse.json({ error: 'EBAY_AUTH_REQUIRED' }, { status: 401 });
  }

  const query = buildSearchQuery(title);

  const params = new URLSearchParams({
    q: query,
    filter: 'buyingOptions:{FIXED_PRICE}',
    sort: 'price',
    limit: '10',
  });

  try {
    const url = `${getBrowseApiBaseUrl()}/item_summary/search?${params.toString()}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        // Required marketplace context header for Browse API
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
        'X-EBAY-C-ENDUSERCTX': 'affiliateCampaignId=<ePNCampaignId>,affiliateReferenceId=<referenceId>',
      },
    });

    if (!res.ok) {
      const text = await res.text();
      console.error('[comparable-prices] Browse API error:', res.status, text);
      return NextResponse.json(
        { error: `eBay Browse API error: ${res.status}` },
        { status: 500 }
      );
    }

    const data = await res.json();
    const rawItems: any[] = data?.itemSummaries ?? [];

    const comparables: ComparableListing[] = [];

    for (const item of rawItems) {
      const id: string = item.itemId ?? '';
      // Skip the listing being compared
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
    return NextResponse.json(
      { error: err.message || 'Failed to fetch comparable prices' },
      { status: 500 }
    );
  }
}