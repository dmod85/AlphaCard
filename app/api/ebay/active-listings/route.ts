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
  sku?: string;
}

interface ItemSpecifics {
  year?: string;
  brand?: string;
  set?: string;
  cardNumber?: string;
  parallel?: string;
  sport?: string;
  player?: string;
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
    const sku = item.match(/<SKU>(.*?)<\/SKU>/)?.[1] || undefined;

    if (itemId) {
      // Pass an empty object to buildSeoTitle just for the initial list check
      const seoTitle = buildSeoTitle(title, {});
      const isSeoFriendly = title === seoTitle;
      listings.push({ itemId, title, price, url, pictureUrl, quantity, quantityAvailable, startTime, isSeoFriendly, sku });
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

function extractBrandFromTitle(title: string): string | undefined {
  const brands = ['Topps', 'Panini', 'Upper Deck', 'Bowman', 'Leaf', 'Fleer', 'Donruss', 'Score', 'O-Pee-Chee', 'Futera'];
  for (const b of brands) {
    if (new RegExp(`\\b${b}\\b`, 'i').test(title)) {
      return b;
    }
  }
  return undefined;
}

// Enforces Visual Uniformity (Title Case) and strict SEO ordering
function buildSeoTitle(originalTitle: string, specifics: ItemSpecifics): string {
  const MAX_LENGTH = 80;

  // 1. Remove spammy fluff
  const FLUFF = /\b(WOW|L@@K|LOOK!*|AMAZING|GORGEOUS|BEAUTIFUL|MUST\s*SEE|FREE\s*SHIP(?:PING)?|FAST\s*SHIP(?:PING)?|HOT|FIRE|INVEST|GEM|MINT)\b/gi;
  let title = originalTitle.replace(FLUFF, '').replace(/\s{2,}/g, ' ').trim();

  // 2. Convert to Title Case to visually normalize EVERYTHING
  title = title.toLowerCase().split(/\s+/).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');

  // 3. Standardize common trading-card abbreviations (Force Upper Case & Remove Parens)
  const abbrevMap: [RegExp, string][] = [
    [/\bpsa\b/gi, 'PSA'],
    [/\bbgs\b/gi, 'BGS'],
    [/\bsgc\b/gi, 'SGC'],
    [/\bcgc\b/gi, 'CGC'],
    // Step 1: Replace two-word form "rookie card" (with optional parens) first
    [/\(?\brookie\s+card\b\)?/gi, 'RC'],
    // Step 2: Replace remaining standalone "rookie" or "rc" (with optional parens)
    [/\(?\b(?:rookie|rc)\b\)?/gi, 'RC'],
    [/\bauto(?:graph)?(?:ed)?\b/gi, 'Auto'],
    [/\brefractor\b/gi, 'Refractor'],
    [/\bholographic\b/gi, 'Holo'],
    [/\bprisms?\b/gi, 'Prizm'],
    [/\bparallel\b/gi, 'Parallel'],
    [/\bshort\s*print\b/gi, 'SP'],
    [/\bsuper\s*short\s*print\b/gi, 'SSP'],
    [/\bfifa\b/gi, 'FIFA'],
    [/\bmlb\b/gi, 'MLB'],
    [/\bnba\b/gi, 'NBA'],
    [/\bnfl\b/gi, 'NFL'],
    [/\bnhl\b/gi, 'NHL'],
    [/\bufc\b/gi, 'UFC'],
    [/\bwwe\b/gi, 'WWE'],
    [/\buefa\b/gi, 'UEFA'],
    [/\bwnba\b/gi, 'WNBA'],
    [/\bnwsl\b/gi, 'NWSL'],
    [/\busfl\b/gi, 'USFL'],
    [/\bxfl\b/gi, 'XFL'],
    [/\bmls\b/gi, 'MLS'],
  ];
  for (const [pattern, replacement] of abbrevMap) {
    title = title.replace(pattern, replacement);
  }

  // Deduplicate consecutive RC tokens (e.g. "RC RC" -> "RC") that can arise
  // when a title contains both "Rookie Card" and a standalone "RC"
  title = title.replace(/\bRC(?:\s+RC)+\b/g, 'RC');

  title = title.replace(/\bWorld\s+Cup\b/gi, 'World Cup');

  if (/\bWorld\s+Cup\b/i.test(title) && !hasWorldCupCountry(title)) {
    const country = inferWorldCupCountry(title);
    if (country) {
      title = `${title} ${country}`;
    }
  }

  // 4. Force uppercase on any token that looks like a card number (e.g., #bcp-95 -> #BCP-95)
  title = title.split(' ').map(word => word.startsWith('#') ? word.toUpperCase() : word).join(' ');

  // 5. Force Year to front
  const yearStr = specifics?.year?.match(/\b(19|20)\d{2}\b/)?.[0] || title.match(/\b(19|20)\d{2}\b/)?.[0];
  if (yearStr) {
    title = title.replace(new RegExp(`\\b${yearStr}\\b`, 'g'), '').replace(/^\s*[-–—]\s*/, '').trim();
    title = `${yearStr} ${title}`;
  }

  // 6. Ensure Card Number is at the end if we have it in item specifics and it's missing
  if (specifics?.cardNumber) {
    const cardNum = specifics.cardNumber.trim().toUpperCase();
    const numPattern = new RegExp(`\\b#?\\s*${cardNum.replace(/[^A-Z0-9]/g, '')}\\b`, 'i');
    if (!numPattern.test(title)) {
      title = `${title} #${cardNum}`;
    }
  }

  title = title.replace(/\s{2,}/g, ' ').trim();

  // 7. Truncate to eBay's 80-character hard limit without splitting words
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

function buildGetItemRequest(itemId: string, token: string): string {
  const credentials = isOAuthToken(token)
    ? ''
    : `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>`;
  return `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  ${credentials}
  <ItemID>${itemId}</ItemID>
  <IncludeItemSpecifics>true</IncludeItemSpecifics>
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
</GetItemRequest>`;
}

function parseItemSpecifics(xml: string): ItemSpecifics {
  const result: ItemSpecifics = {};
  const nvRegex = /<NameValueList>([\s\S]*?)<\/NameValueList>/g;
  let m;
  while ((m = nvRegex.exec(xml)) !== null) {
    const block = m[1];
    const name = (block.match(/<Name>(.*?)<\/Name>/)?.[1] || '').toLowerCase().trim();
    const value = decodeXml((block.match(/<Value>(.*?)<\/Value>/)?.[1] || '').trim());

    if (name === 'set') result.set = value;
    else if (name === 'year manufactured' || name === 'season') result.year = value;
    else if (name === 'card number') result.cardNumber = value;
    else if (name === 'parallel/variety') result.parallel = value;
    else if (name === 'sport') result.sport = value;
    else if (name === 'manufacturer' || name === 'brand') result.brand = value;
    else if (name === 'player/athlete' || name === 'player') result.player = value;
  }
  return result;
}

// Format: YY-BRAND-SET_NAME-SPORT (e.g. 26-TOPPS-SERIES_1-BASEBALL)
function buildParentSku(specifics: ItemSpecifics, titleYear?: string, titleBrand?: string): string | null {
  const year = specifics.year || titleYear;
  const brand = specifics.brand || titleBrand || 'UNKNOWN';
  const set = specifics.set || 'UNKNOWN';
  const sport = specifics.sport || 'UNKNOWN';

  if (!year) return null;

  const twoDigit = year.slice(-2);

  const cleanBrand = brand.toUpperCase().replace(/\s+/g, '_').replace(/[^A-Z0-9_]/g, '');

  let cleanSet = set.replace(new RegExp(`^${year}\\s*`, 'i'), '').trim();
  cleanSet = cleanSet.replace(new RegExp(`^${brand}\\s*`, 'i'), '').trim();
  cleanSet = cleanSet.toUpperCase().replace(/\s+/g, '_').replace(/[^A-Z0-9_]/g, '');

  const cleanSport = sport.toUpperCase().replace(/\s+/g, '_').replace(/[^A-Z0-9_]/g, '');

  return `${twoDigit}-${cleanBrand}-${cleanSet}-${cleanSport}`;
}

// Format: [ParentSKU]-[CARDNUMBER]
function buildChildSku(parentSku: string, cardNumber: string, parallel?: string): string {
  const num = cardNumber.replace(/^#/, '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  let sku = `${parentSku}-${num}`;

  // Only append parallel if it's a distinct variation to avoid colliding with base card SKU
  if (parallel && parallel.toUpperCase() !== 'BASE') {
    const par = parallel.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    sku = `${sku}-${par}`;
  }

  return sku.slice(0, 50); // eBay limit safety
}

function buildReviseItemRequest(itemId: string, seoTitle: string, description: string, token: string, sku?: string): string {
  const credentials = isOAuthToken(token)
    ? ''
    : `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>`;

  const skuElement = sku ? `\n    <SKU>${escapeXml(sku)}</SKU>` : '';
  return `<?xml version="1.0" encoding="utf-8"?>
<ReviseItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  ${credentials}
  <Item>
    <ItemID>${itemId}</ItemID>
    <Title>${escapeXml(seoTitle)}</Title>
    <Description><![CDATA[${description}]]></Description>${skuElement}
  </Item>
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
</ReviseItemRequest>`;
}

// GET — fetch active listings (all pages)
export async function GET() {
  try {
    const token = await getValidToken();

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

// POST — rewrite titles/descriptions and assign Child SKU as Custom Label
export async function POST(request: NextRequest) {
  try {
    const { items } = await request.json() as { items: Array<{ itemId: string; title: string }> };

    if (!items || !Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: 'No items provided' }, { status: 400 });
    }

    const token = await getValidToken();

    const specificsMap = new Map<string, ItemSpecifics>();
    await Promise.all(
      items.map(async (item) => {
        try {
          const xml = buildGetItemRequest(item.itemId, token);
          const response = await callEbayApi(xml, 'GetItem', token);
          specificsMap.set(item.itemId, parseItemSpecifics(response));
        } catch {
          specificsMap.set(item.itemId, {});
        }
      })
    );

    const results: Array<{
      itemId: string;
      success: boolean;
      seoTitle?: string;
      parentSku?: string;
      childSku?: string;
      error?: string;
    }> = [];

    for (const item of items) {
      try {
        const specifics = specificsMap.get(item.itemId) || {};

        // Pass item specifics down to structurally govern the Title Convention
        const seoTitle = buildSeoTitle(item.title, specifics);
        const description = buildDescription(item.title);

        const titleYear = item.title.match(/\b((19|20)\d{2})\b/)?.[1];
        const titleBrand = extractBrandFromTitle(item.title);

        const parentSku = buildParentSku(specifics, titleYear, titleBrand) ?? undefined;
        const childSku = parentSku && specifics.cardNumber != null
          ? buildChildSku(parentSku, specifics.cardNumber, specifics.parallel)
          : undefined;

        const xml = buildReviseItemRequest(item.itemId, seoTitle, description, token, childSku);
        const response = await callEbayApi(xml, 'ReviseItem', token);

        const ack = response.match(/<Ack>(.*?)<\/Ack>/)?.[1];
        if (ack === 'Success' || ack === 'Warning') {
          results.push({ itemId: item.itemId, success: true, seoTitle, parentSku, childSku });
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