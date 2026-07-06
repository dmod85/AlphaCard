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
    // a known brand, year, or league — likely the athlete name.
    const titleCaseRuns = [...cleaned.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/g)];
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
  //    Player name is the required anchor — subset name adds specificity but
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