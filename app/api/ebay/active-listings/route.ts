import { NextRequest, NextResponse } from 'next/server';
import { getValidToken, isOAuthToken, getEbayApiHeaders, getEbayApiUrl, clearTokenCache } from '@/app/lib/ebay-auth';
import { supabaseAdmin } from '@/app/lib/supabase-admin';

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

function buildGetSellerListRequest(page: number, token: string): string {
  const credentials = isOAuthToken(token)
    ? ''
    : `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>`;

  const now = new Date();
  const future = new Date();
  future.setDate(future.getDate() + 120);

  return `<?xml version="1.0" encoding="utf-8"?>
<GetSellerListRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  ${credentials}
  <Pagination>
    <EntriesPerPage>200</EntriesPerPage>
    <PageNumber>${page}</PageNumber>
  </Pagination>
  <DetailLevel>ItemReturnDescription</DetailLevel>
  <IncludeItemSpecifics>true</IncludeItemSpecifics>
  <EndTimeFrom>${now.toISOString()}</EndTimeFrom>
  <EndTimeTo>${future.toISOString()}</EndTimeTo>
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
</GetSellerListRequest>`;
}

interface NameValuePair {
  name: string;
  value: string;
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
  specifics: NameValuePair[];
}

interface ItemSpecifics {
  year?: string;
  brand?: string;
  set?: string;
  cardNumber?: string;
  parallel?: string;
  insert?: string;
  sport?: string;
  player?: string;
  team?: string;
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
    else if (name === 'insert') result.insert = value;
    else if (name === 'sport') result.sport = value;
    else if (name === 'manufacturer' || name === 'brand') result.brand = value;
    else if (name === 'player/athlete' || name === 'player') result.player = value;
    else if (name === 'team') result.team = value;
  }
  return result;
}

function parseAllSpecifics(xml: string): NameValuePair[] {
  const result: NameValuePair[] = [];
  const nvRegex = /<NameValueList>([\s\S]*?)<\/NameValueList>/g;
  let m;
  while ((m = nvRegex.exec(xml)) !== null) {
    const block = m[1];
    const name = decodeXml((block.match(/<Name>(.*?)<\/Name>/)?.[1] || '').trim());
    const value = decodeXml((block.match(/<Value>(.*?)<\/Value>/)?.[1] || '').trim());
    if (name && value) result.push({ name, value });
  }
  return result;
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
      // Parse item specifics for SEO title check
      const specifics = parseItemSpecifics(item);
      const seoTitle = buildSeoTitle(specifics);
      const isSeoFriendly = title === seoTitle;

      // Parse all specifics as raw name-value pairs for display
      const allSpecifics = parseAllSpecifics(item);

      listings.push({ itemId, title, price, url, pictureUrl, quantity, quantityAvailable, startTime, isSeoFriendly, sku, specifics: allSpecifics });
    }
  }

  return listings;
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

// Builds the listing title strictly from eBay item specifics:
//   [Set] - [Player/Athlete] [Card Number] - [Parallel/Variety] [Team]
// The Set field is used as-is for Year/Brand/Set (eBay's Set value already
// carries all three, e.g. "2024 Topps Chrome"). Parallel/Variety is omitted
// when it's just "Base". Team is only appended if it fits under MAX_LENGTH.
function buildSeoTitle(specifics: ItemSpecifics): string {
  const MAX_LENGTH = 80;

  const na = (v: string) => v.trim().toLowerCase() === 'n/a' ? '' : v.trim();
  const notBase = (v: string) => v.replace(/[\[\]]/g, '').trim().toLowerCase() === 'base' ? '' : v;

  const set = na(specifics.set || '');
  const player = na(specifics.player || '');

  const cardNumberRaw = na(specifics.cardNumber || '');
  const cardNumber = cardNumberRaw
    ? (cardNumberRaw.startsWith('#') ? cardNumberRaw.toUpperCase() : `#${cardNumberRaw.toUpperCase()}`)
    : '';

  const parallel = notBase(na(specifics.parallel || ''));
  const insert = notBase(na(specifics.insert || ''));

  const team = na(specifics.team || '');

  const parts: string[] = [];
  if (set) parts.push(set);

  if (player) {
    if (set) parts.push('-');
    parts.push(player);
  }

  if (cardNumber) parts.push(cardNumber);

  if (parallel || insert) {
    if (set || player) parts.push('-');
    if (parallel) parts.push(parallel);
    if (insert) parts.push(insert);
  }

  let title = parts.join(' ').replace(/\s{2,}/g, ' ').trim();

  // Attributes: only add the full team name if there's room within the title limit
  if (team) {
    const withTeam = `${title} ${team}`.replace(/\s{2,}/g, ' ').trim();
    if (withTeam.length <= MAX_LENGTH) {
      title = withTeam;
    }
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



// Format: YEAR-BRAND-SET_NAME-SPORT (e.g. 2026-TOPPS-CHROME-UFC)
function buildSku(specifics: ItemSpecifics, titleYear?: string, titleBrand?: string): string | null {
  const year = specifics.year || titleYear;
  const brand = specifics.brand || titleBrand || 'UNKNOWN';
  const set = specifics.set || 'UNKNOWN';
  const sport = specifics.sport || 'UNKNOWN';

  if (!year) return null;

  // Use full 4 digit year
  const year4 = year.match(/\b(19|20)\d{2}\b/)?.[0] || year;

  const cleanBrand = brand.toUpperCase().replace(/\s+/g, '-').replace(/[^A-Z0-9-]/g, '');

  let cleanSet = set.replace(new RegExp(`^${year4}\\s*`, 'i'), '').trim();
  cleanSet = cleanSet.replace(new RegExp(`^${brand}\\s*`, 'i'), '').trim();
  cleanSet = cleanSet.toUpperCase().replace(/\s+/g, '-').replace(/[^A-Z0-9-]/g, '');

  const cleanSport = sport.toUpperCase().replace(/\s+/g, '-').replace(/[^A-Z0-9-]/g, '');

  return `${year4}-${cleanBrand}-${cleanSet}-${cleanSport}`;
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

// GET — fetch active listings (lazy loaded by page)
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get('page') || '1', 10);
    const token = await getValidToken();

    const firstXml = buildGetSellerListRequest(page, token);
    const firstResponse = await callEbayApi(firstXml, 'GetSellerList', token);

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
    const listings = parseActiveListings(firstResponse);

    return NextResponse.json({ listings, total, totalPages, currentPage: page });
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
    const skuMap = new Map<string, string>();
    await Promise.all(
      items.map(async (item) => {
        try {
          const xml = buildGetItemRequest(item.itemId, token);
          const response = await callEbayApi(xml, 'GetItem', token);
          specificsMap.set(item.itemId, parseItemSpecifics(response));
          
          const existingSku = response.match(/<SKU>(.*?)<\/SKU>/)?.[1];
          if (existingSku) {
            skuMap.set(item.itemId, decodeXml(existingSku));
          }
        } catch {
          specificsMap.set(item.itemId, {});
        }
      })
    );

    const results: Array<{
      itemId: string;
      success: boolean;
      seoTitle?: string;
      sku?: string;
      error?: string;
    }> = [];

    const successfulItemIds: string[] = [];

    for (const item of items) {
      try {
        const specifics = specificsMap.get(item.itemId) || {};
        const existingSku = skuMap.get(item.itemId) || '';

        // Title is built strictly from item specifics — no parsing of the old title
        const seoTitle = buildSeoTitle(specifics);
        const description = buildDescription(seoTitle);

        const titleYear = item.title.match(/\b((19|20)\d{2})\b/)?.[1];
        const titleBrand = extractBrandFromTitle(item.title);

        let finalSku: string | undefined = undefined;
        if (!existingSku.toLowerCase().startsWith('lot')) {
          finalSku = buildSku(specifics, titleYear, titleBrand) ?? undefined;
        }

        const xml = buildReviseItemRequest(item.itemId, seoTitle, description, token, finalSku);
        const response = await callEbayApi(xml, 'ReviseItem', token);

        const ack = response.match(/<Ack>(.*?)<\/Ack>/)?.[1];
        if (ack === 'Success' || ack === 'Warning') {
          results.push({ itemId: item.itemId, success: true, seoTitle, sku: finalSku });
          successfulItemIds.push(item.itemId);
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

    // Stamp description_ok = true in Supabase for all successfully revised items.
    // This lets the Description Check read from cache instead of re-fetching live HTML.
    // We use .update() (not upsert) so we only flip the flag without clobbering cached specifics.
    if (successfulItemIds.length > 0) {
      await supabaseAdmin
        .from('ebay_item_specifics')
        .update({ description_ok: true, updated_at: new Date().toISOString() })
        .in('item_id', successfulItemIds);
    }

    return NextResponse.json({ results });
  } catch (err: any) {
    if (err.message === 'EBAY_AUTH_REQUIRED') {
      return NextResponse.json({ error: 'EBAY_AUTH_REQUIRED' }, { status: 401 });
    }
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}