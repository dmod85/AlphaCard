import { NextRequest, NextResponse } from 'next/server';
import { getValidToken, isOAuthToken, getEbayApiHeaders, getEbayApiUrl, clearTokenCache } from '@/app/lib/ebay-auth';

// eBay Trading API error codes that indicate an invalid/expired token
const EBAY_AUTH_ERROR_CODES = ['21917053', '21916984', '21917055'];

function isEbayAuthError(xml: string): boolean {
  return EBAY_AUTH_ERROR_CODES.some(code => xml.includes(`<ErrorCode>${code}</ErrorCode>`))
    || /validation of the authentication token/i.test(xml);
}

function decodeXml(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function callEbayApi(xmlBody: string, callName: string, token: string): Promise<string> {
  const response = await fetch(getEbayApiUrl(), {
    method: 'POST',
    headers: getEbayApiHeaders(callName, token),
    body: xmlBody,
  });
  return response.text();
}

function buildGetMyeBaySellingRequest(page: number, token: string): string {
  // Only include RequesterCredentials for legacy Auth'n'Auth tokens.
  // OAuth2 tokens are sent via X-EBAY-API-IAF-TOKEN header instead.
  const credentials = isOAuthToken(token)
    ? ''
    : `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>`;

  return `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  ${credentials}
  <ActiveList>
    <Include>true</Include>
    <Pagination>
      <EntriesPerPage>200</EntriesPerPage>
      <PageNumber>${page}</PageNumber>
    </Pagination>
    <Sort>EndTime</Sort>
  </ActiveList>
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
</GetMyeBaySellingRequest>`;
}

interface ActiveListing {
  itemId: string;
  title: string;
  price: number;
  url: string;
  pictureUrl?: string;
  quantity: number;
  quantityAvailable: number;
  startTime: string;
  isSeoFriendly: boolean;
}

function parseActiveListings(xml: string): ActiveListing[] {
  const listings: ActiveListing[] = [];

  const itemArrayMatch = xml.match(/<ItemArray>([\s\S]*?)<\/ItemArray>/);
  if (!itemArrayMatch) return listings;

  const itemArrayXml = itemArrayMatch[1];
  const itemRegex = /<Item>([\s\S]*?)<\/Item>/g;
  let match;

  while ((match = itemRegex.exec(itemArrayXml)) !== null) {
    const item = match[1];

    const itemId = item.match(/<ItemID>(.*?)<\/ItemID>/)?.[1] || '';
    const title = decodeXml(item.match(/<Title>(.*?)<\/Title>/)?.[1] || '');
    const price = parseFloat(item.match(/<CurrentPrice[^>]*>(.*?)<\/CurrentPrice>/)?.[1] || '0');
    const url = item.match(/<ViewItemURL>(.*?)<\/ViewItemURL>/)?.[1] || '';
    const pictureUrl = item.match(/<GalleryURL>(.*?)<\/GalleryURL>/)?.[1] 
      || item.match(/<PictureURL>(.*?)<\/PictureURL>/)?.[1];
    const quantity = parseInt(item.match(/<Quantity>(.*?)<\/Quantity>/)?.[1] || '1');
    const quantityAvailable = parseInt(item.match(/<QuantityAvailable>(.*?)<\/QuantityAvailable>/)?.[1] || '1');
    const startTime = item.match(/<StartTime>(.*?)<\/StartTime>/)?.[1] || '';

    if (itemId) {
      // A title is SEO friendly if it starts with a year and doesn't change when optimized
      const seoTitle = buildSeoTitle(title);
      const isSeoFriendly = title === seoTitle;
      listings.push({ itemId, title, price, url, pictureUrl, quantity, quantityAvailable, startTime, isSeoFriendly });
    }
  }

  return listings;
}

const WORLD_CUP_COUNTRIES = [
  'Argentina', 'Brazil', 'England', 'France', 'Germany', 'Italy', 'Spain', 'Portugal',
  'Netherlands', 'Belgium', 'Croatia', 'Uruguay', 'USA', 'Mexico', 'Japan', 'South Korea',
] as const;

const WORLD_CUP_PLAYER_COUNTRY_HINTS: Array<{ pattern: RegExp; country: typeof WORLD_CUP_COUNTRIES[number] }> = [
  { pattern: /\bharry\s+kane\b/i, country: 'England' },
  { pattern: /\bjude\s+bellingham\b/i, country: 'England' },
  { pattern: /\bbukayo\s+saka\b/i, country: 'England' },
  { pattern: /\bphil\s+foden\b/i, country: 'England' },
  { pattern: /\blionel\s+messi\b/i, country: 'Argentina' },
  { pattern: /\bkylian\s+mbappe\b/i, country: 'France' },
  { pattern: /\bcristiano\s+ronaldo\b/i, country: 'Portugal' },
  { pattern: /\bvinicius\s+jr\b/i, country: 'Brazil' },
  { pattern: /\bvinicius\s+junior\b/i, country: 'Brazil' },
  { pattern: /\bpedri\b/i, country: 'Spain' },
  { pattern: /\bluka\s+modric\b/i, country: 'Croatia' },
];

function hasWorldCupCountry(title: string): boolean {
  return WORLD_CUP_COUNTRIES.some(country => new RegExp(`\\b${country.replace(/\s+/g, '\\s+')}\\b`, 'i').test(title));
}

function inferWorldCupCountry(title: string): string | null {
  for (const hint of WORLD_CUP_PLAYER_COUNTRY_HINTS) {
    if (hint.pattern.test(title)) return hint.country;
  }
  return null;
}

// Optimizes a listing title for eBay SEO — year first, standardized abbreviations,
// fluff removed, capped at eBay's 80-character limit.
function buildSeoTitle(originalTitle: string): string {
  const MAX_LENGTH = 80;

  const FLUFF = /\b(WOW|L@@K|LOOK!*|AMAZING|GORGEOUS|BEAUTIFUL|MUST\s*SEE|FREE\s*SHIP(?:PING)?|FAST\s*SHIP(?:PING)?|HOT|FIRE)\b/gi;
  let title = originalTitle.replace(FLUFF, '').replace(/\s{2,}/g, ' ').trim();

  // Standardize common trading-card abbreviations
  const abbrevMap: [RegExp, string][] = [
    [/\bpsa\b/gi, 'PSA'],
    [/\bbgs\b/gi, 'BGS'],
    [/\bsgc\b/gi, 'SGC'],
    [/\b(rookie\s*card|rookie)\b/gi, 'RC'],
    [/\bauto(?:graph)?\b/gi, 'AUTO'],
    [/\brefractor\b/gi, 'Refractor'],
    [/\bholographic\b/gi, 'Holo'],
    [/\bprisms?\b/gi, 'Prizm'],
    [/\bparallel\b/gi, 'Parallel'],
    [/\bshort\s*print\b/gi, 'SP'],
    [/\bsuper\s*short\s*print\b/gi, 'SSP'],
    [/\bpatch\b/gi, 'Patch'],
    [/\bnumbered\b/gi, 'Numbered'],
  ];
  for (const [pattern, replacement] of abbrevMap) {
    title = title.replace(pattern, replacement);
  }

  // Keep FIFA in all caps and normalize World Cup casing.
  title = title.replace(/\bfifa\b/gi, 'FIFA');
  title = title.replace(/\bworld\s+cup\b/gi, 'World Cup');

  // For World Cup cards, append the national team when it can be inferred.
  if (/\bworld\s+cup\b/i.test(title) && !hasWorldCupCountry(title)) {
    const country = inferWorldCupCountry(title);
    if (country) {
      title = `${title} ${country}`.replace(/\s{2,}/g, ' ').trim();
    }
  }

  // Ensure year (19xx / 20xx) appears first
  const yearMatch = title.match(/\b(19|20)\d{2}\b/);
  if (yearMatch) {
    const year = yearMatch[0];
    title = `${year} ${title.replace(year, '').replace(/^\s*[-–—]\s*/, '').trim()}`.replace(/\s{2,}/g, ' ').trim();
  }

  // Truncate to eBay's 80-character hard limit without splitting words
  if (title.length > MAX_LENGTH) {
    const cut = title.lastIndexOf(' ', MAX_LENGTH);
    title = title.substring(0, cut > MAX_LENGTH - 15 ? cut : MAX_LENGTH).trim();
  }

  return title;
}

function buildDescription(title: string): string {
  return `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.8;color:#222;max-width:700px">
  <p><b>Card Details:</b> &gt; ${title}.</p>
  <p><b>Condition:</b> &gt; Pack fresh, placed directly into a penny sleeve and toploader. Card is Near Mint or Better. Please see high-resolution photos for exact condition.</p>
  <p><b>Shipping:</b> &gt; Shipped securely via eBay Standard Envelope in a reinforced mailer to ensure it arrives safely.</p>
</div>`;
}

function buildReviseItemRequest(itemId: string, seoTitle: string, description: string, token: string): string {
  const credentials = isOAuthToken(token)
    ? ''
    : `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>`;

  return `<?xml version="1.0" encoding="utf-8"?>
<ReviseItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  ${credentials}
  <Item>
    <ItemID>${itemId}</ItemID>
    <Title>${escapeXml(seoTitle)}</Title>
    <Description><![CDATA[${description}]]></Description>
  </Item>
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
</ReviseItemRequest>`;
}

// GET — fetch active listings (all pages)
export async function GET() {
  try {
    const token = await getValidToken();

    // Fetch page 1 to determine total page count
    const firstXml = buildGetMyeBaySellingRequest(1, token);
    const firstResponse = await callEbayApi(firstXml, 'GetMyeBaySelling', token);

    const ack = firstResponse.match(/<Ack>(.*?)<\/Ack>/)?.[1];
    if (ack === 'Failure') {
      const errorMsg = firstResponse.match(/<LongMessage>(.*?)<\/LongMessage>/)?.[1]
        || firstResponse.match(/<ShortMessage>(.*?)<\/ShortMessage>/)?.[1]
        || 'eBay API error';
      console.error('[active-listings] eBay API failure:', decodeXml(errorMsg));
      if (isEbayAuthError(firstResponse)) {
        clearTokenCache();
        return NextResponse.json({ error: 'EBAY_AUTH_REQUIRED' }, { status: 401 });
      }
      return NextResponse.json({ error: decodeXml(errorMsg) }, { status: 500 });
    }

    const total = parseInt(firstResponse.match(/<TotalNumberOfEntries>(.*?)<\/TotalNumberOfEntries>/)?.[1] || '0');
    const totalPages = parseInt(firstResponse.match(/<TotalNumberOfPages>(.*?)<\/TotalNumberOfPages>/)?.[1] || '1');
    const allListings = parseActiveListings(firstResponse);

    // Fetch remaining pages in parallel
    if (totalPages > 1) {
      const pageNums = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
      const pageResponses = await Promise.all(
        pageNums.map(page => callEbayApi(buildGetMyeBaySellingRequest(page, token), 'GetMyeBaySelling', token))
      );
      for (const pageResponse of pageResponses) {
        allListings.push(...parseActiveListings(pageResponse));
      }
    }

    return NextResponse.json({ listings: allListings, total });
  } catch (err: any) {
    if (err.message === 'EBAY_AUTH_REQUIRED') {
      return NextResponse.json({ error: 'EBAY_AUTH_REQUIRED' }, { status: 401 });
    }
    return NextResponse.json({ error: err.message || 'Failed to fetch listings' }, { status: 500 });
  }
}

// POST — rewrite descriptions for selected items
export async function POST(request: NextRequest) {
  try {
    const { items } = await request.json() as { items: Array<{ itemId: string; title: string }> };

    if (!items || !Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: 'No items provided' }, { status: 400 });
    }

    const token = await getValidToken();
    const results: Array<{ itemId: string; success: boolean; seoTitle?: string; error?: string }> = [];

    for (const item of items) {
      try {
        const seoTitle = buildSeoTitle(item.title);
        const description = buildDescription(item.title);
        const xml = buildReviseItemRequest(item.itemId, seoTitle, description, token);
        const response = await callEbayApi(xml, 'ReviseItem', token);

        const ack = response.match(/<Ack>(.*?)<\/Ack>/)?.[1];
        if (ack === 'Success' || ack === 'Warning') {
          results.push({ itemId: item.itemId, success: true, seoTitle });
        } else {
          const error = response.match(/<LongMessage>(.*?)<\/LongMessage>/)?.[1]
            || response.match(/<ShortMessage>(.*?)<\/ShortMessage>/)?.[1]
            || 'Unknown eBay error';
          results.push({ itemId: item.itemId, success: false, error: decodeXml(error) });
        }
      } catch (err: any) {
        results.push({ itemId: item.itemId, success: false, error: err.message || 'Network error' });
      }
    }

    return NextResponse.json({ results });
  } catch (err: any) {
    if (err.message === 'EBAY_AUTH_REQUIRED') {
      return NextResponse.json({ error: 'EBAY_AUTH_REQUIRED' }, { status: 401 });
    }
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}
