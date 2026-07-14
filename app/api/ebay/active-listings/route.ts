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
  <EndTimeFrom>${now.toISOString()}</EndTimeFrom>
  <EndTimeTo>${future.toISOString()}</EndTimeTo>
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
</GetSellerListRequest>`;
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
    const rawDescription = decodeXml(item.match(/<Description>([\s\S]*?)<\/Description>/)?.[1] || '');

    if (itemId) {
      // Pass an empty object to buildSeoTitle just for the initial list check
      const seoTitle = buildSeoTitle(title, {});
      const expectedDesc = buildDescription(title);
      
      const normalizeDesc = (d: string) => d.replace(/[\s\r\n]+/g, ' ').trim();
      const isDescFriendly = normalizeDesc(rawDescription) === normalizeDesc(expectedDesc);
      
      const isSeoFriendly = title === seoTitle && isDescFriendly;
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

  // 5. Extract and Reorder components
  let playerStr = specifics?.player || '';
  if (playerStr) {
    playerStr = playerStr.toLowerCase().split(/\s+/).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  }

  // Year
  const yearStr = specifics?.year?.match(/\b(19|20)\d{2}\b/)?.[0] || title.match(/\b(19|20)\d{2}\b/)?.[0] || '';
  if (yearStr) {
    title = title.replace(new RegExp(`\\b${yearStr}\\b`, 'g'), '').replace(/\s{2,}/g, ' ').trim();
  }

  let leftPart = '';
  let rightPart = title;

  // Split title by Player Name to isolate Brand/Set (left) from Parallel/Color (right)
  if (playerStr) {
    // Try to handle slight accent differences by removing accents for matching if needed, 
    // but a safe regex is usually fine for most English cards
    const safePlayer = playerStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const playerRegex = new RegExp(`\\b${safePlayer}\\b`, 'i');
    const match = playerRegex.exec(rightPart);
    if (match) {
      leftPart = rightPart.substring(0, match.index).trim();
      rightPart = rightPart.substring(match.index + match[0].length).trim();
    }
  }

  // Clean up leftPart
  leftPart = leftPart.replace(/^[-–—,]\s*/, '').replace(/\s*[-–—,]$/, '').trim();

  // Refine leftPart to ONLY contain Brand & Set, moving any Insert/Parallel info prepended before player into rightPart
  const brand = specifics?.brand || extractBrandFromTitle(originalTitle);
  let set = specifics?.set || '';
  
  if (brand && set.toLowerCase().includes(brand.toLowerCase())) {
      set = set.replace(new RegExp(`\\b${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), '').trim();
  }
  
  let finalBrandSet = '';
  
  if (brand) {
      const safeBrand = brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const brandRegex = new RegExp(`\\b${safeBrand}\\b`, 'gi');
      
      let match = leftPart.match(brandRegex) || rightPart.match(brandRegex);
      if (match) {
          finalBrandSet += match[0] + ' ';
      } else {
          const forcedBrand = brand.toLowerCase().split(/\s+/).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
          finalBrandSet += forcedBrand + ' '; 
      }
      leftPart = leftPart.replace(brandRegex, ' ').trim();
      rightPart = rightPart.replace(brandRegex, ' ').trim();
  }
  
  if (set) {
      const safeSet = set.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const setRegex = new RegExp(`\\b${safeSet}\\b`, 'gi');
      
      let match = leftPart.match(setRegex) || rightPart.match(setRegex);
      if (match) {
          finalBrandSet += match[0] + ' ';
      } else {
          let forcedSet = set.toLowerCase().split(/\s+/).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
          for (const [pattern, replacement] of abbrevMap) {
              forcedSet = forcedSet.replace(pattern, replacement);
          }
          finalBrandSet += forcedSet + ' ';
      }
      leftPart = leftPart.replace(setRegex, ' ').trim();
      rightPart = rightPart.replace(setRegex, ' ').trim();
  }
  
  if (leftPart) {
      rightPart = leftPart + ' ' + rightPart;
  }
  
  leftPart = finalBrandSet.trim();

  // Card Number
  let cardNumStr = specifics?.cardNumber ? specifics.cardNumber.trim().toUpperCase() : '';
  let extractedCardNum = '';
  if (cardNumStr) {
    const safeNum = cardNumStr.replace(/[^A-Z0-9]/g, '');
    const numPattern = new RegExp(`(?:^|\\s)#?\\s*${safeNum}\\b`, 'i');
    if (numPattern.test(rightPart)) {
      rightPart = rightPart.replace(numPattern, ' ').trim();
    }
    extractedCardNum = cardNumStr.startsWith('#') ? cardNumStr : `#${cardNumStr}`;
  } else {
    const hashMatch = rightPart.match(/(?:^|\s)#[A-Z0-9-]+\b/i);
    if (hashMatch) {
      extractedCardNum = hashMatch[0].trim().toUpperCase();
      rightPart = rightPart.replace(hashMatch[0], ' ').trim();
    }
  }

  // Attributes (RC, AUTO, RPA, SP, SSP, Serial /99)
  const attributes: string[] = [];
  const attrRegex = /\b(RC|AUTO|RPA|SP|SSP)\b/gi;
  let attrMatch;
  while ((attrMatch = attrRegex.exec(rightPart)) !== null) {
    attributes.push(attrMatch[1].toUpperCase());
  }
  rightPart = rightPart.replace(attrRegex, ' ').replace(/\s{2,}/g, ' ').trim();

  const serialRegex = /(?:^|\s)(\d{1,5}\/\d{1,5}|\/\d{1,5})\b/g;
  let serialMatch;
  while ((serialMatch = serialRegex.exec(rightPart)) !== null) {
    attributes.push(serialMatch[1]);
  }
  rightPart = rightPart.replace(serialRegex, ' ').replace(/\s{2,}/g, ' ').trim();

  // Grade
  const grades: string[] = [];
  const gradeRegex = /\b(PSA|BGS|SGC|CGC)\s*(10|9\.5|9|8\.5|8|7|6|5|4|3|2|1\.5|1)\b/gi;
  let gradeMatch;
  while ((gradeMatch = gradeRegex.exec(rightPart)) !== null) {
    grades.push(`${gradeMatch[1].toUpperCase()} ${gradeMatch[2]}`);
  }
  rightPart = rightPart.replace(gradeRegex, ' ').replace(/\s{2,}/g, ' ').trim();

  // Clean up title (which is now strictly Insert/Parallel/Color + Team info)
  rightPart = rightPart.replace(/\s{2,}/g, ' ').replace(/^[-–—,]\s*/, '').replace(/\s*[-–—,]$/, '').replace(/\s*,\s*/g, ' ').trim();

  // Reconstruct: [Year] [Brand & Set] - [Player Name] [Card #] - [Insert/Parallel/Color] [Attributes] [Grade]
  let finalParts = [];
  if (yearStr) finalParts.push(yearStr);
  if (leftPart) finalParts.push(leftPart); // Brand & Set
  
  if (playerStr) {
    if (leftPart) finalParts.push('-');
    finalParts.push(playerStr);
  }
  
  if (extractedCardNum) finalParts.push(extractedCardNum);
  
  if (rightPart) {
    if (leftPart || playerStr) finalParts.push('-');
    finalParts.push(rightPart); // Insert/Parallel/Color
  }
  
  if (attributes.length > 0) finalParts.push(attributes.join(' '));
  if (grades.length > 0) finalParts.push(grades.join(' '));

  title = finalParts.join(' ').replace(/\s{2,}/g, ' ').trim();

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

// GET — fetch active listings (all pages)
export async function GET() {
  try {
    const token = await getValidToken();

    const firstXml = buildGetSellerListRequest(1, token);
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
    const allListings = parseActiveListings(firstResponse);

    if (totalPages > 1) {
      const pageNums = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
      const pageResponses = await Promise.all(
        pageNums.map(page => callEbayApi(buildGetSellerListRequest(page, token), 'GetSellerList', token))
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

    for (const item of items) {
      try {
        const specifics = specificsMap.get(item.itemId) || {};
        const existingSku = skuMap.get(item.itemId) || '';

        // Pass item specifics down to structurally govern the Title Convention
        const seoTitle = buildSeoTitle(item.title, specifics);
        const description = buildDescription(item.title);

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