import { NextRequest, NextResponse } from 'next/server';
import { getValidToken, isOAuthToken, getEbayApiHeaders, getEbayApiUrl, clearTokenCache } from '@/app/lib/ebay-auth';

function decodeXml(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

async function callEbayApi(xmlBody: string, callName: string, token: string): Promise<string> {
  const response = await fetch(getEbayApiUrl(), {
    method: 'POST',
    headers: getEbayApiHeaders(callName, token),
    body: xmlBody,
  });
  return response.text();
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

// Elements GetItem echoes back that AddItem either rejects outright or
// silently ignores (server-assigned / read-only / listing-history data).
// Everything else in the <Item> block is passed through untouched so the
// new listing matches the original as closely as eBay allows — including
// whichever payment/return/shipping business policies or ItemSpecifics it
// already carries, without us having to enumerate every settable field.
// Note: this also strips <Variations>, so multi-variation listings (rare
// for single cards) will fail AddItem with a clear eBay error rather than
// silently dropping variation data.
const ADD_ITEM_STRIP_TAGS = [
  'ItemID', 'Seller', 'SellingStatus', 'ListingDetails', 'TimeLeft',
  'HitCount', 'HitCounter', 'WatchCount', 'Variations', 'ProductListingDetails',
  'eBayNotes', 'ReviseStatus', 'RelistedItemID', 'RelistLink',
  'QuantityAvailableHint', 'QuantitySold', 'TopRatedListing', 'eBayPlusEligible',
  'ExcludeMoneyBackGuarantee', 'BuyerProtection', 'ConditionDisplayName',
  'BestOfferDetails', 'SiteHostedPicture', 'SellerContactDetails',
  'BuyerResponsibleForShipping', 'ApplicationData',
  // Deprecated Trading API input fields that GetItem still echoes back —
  // eBay ignores them on AddItem but complains via a warning if present.
  'OutOfStockControl', 'HideFromSearch',
];

function stripDisallowedForAddItem(itemXml: string): string {
  let result = itemXml;
  for (const tag of ADD_ITEM_STRIP_TAGS) {
    result = result.replace(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, 'g'), '');
    result = result.replace(new RegExp(`<${tag}(?:\\s[^>]*)?\\/>`, 'g'), '');
  }
  return result;
}

function buildAddItemRequest(itemInnerXml: string, token: string): string {
  const credentials = isOAuthToken(token)
    ? ''
    : `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>`;
  return `<?xml version="1.0" encoding="utf-8"?>
<AddItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  ${credentials}
  <Item>
    ${itemInnerXml}
  </Item>
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
</AddItemRequest>`;
}

function buildEndItemRequest(itemId: string, token: string): string {
  const credentials = isOAuthToken(token)
    ? ''
    : `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>`;
  return `<?xml version="1.0" encoding="utf-8"?>
<EndItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  ${credentials}
  <ItemID>${itemId}</ItemID>
  <EndingReason>NotAvailable</EndingReason>
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
</EndItemRequest>`;
}

function buildViewItemUrl(itemId: string): string {
  const isProd = process.env.EBAY_ENVIRONMENT?.trim() === 'PRODUCTION';
  return isProd ? `https://www.ebay.com/itm/${itemId}` : `https://sandbox.ebay.com/itm/${itemId}`;
}

function firstErrorMessage(xml: string): string {
  return decodeXml(
    xml.match(/<LongMessage>(.*?)<\/LongMessage>/)?.[1] ||
    xml.match(/<ShortMessage>(.*?)<\/ShortMessage>/)?.[1] ||
    'Unknown eBay error'
  );
}

interface ListSimilarResult {
  itemId: string;
  success: boolean;
  ended: boolean;
  newItemId?: string;
  newItemUrl?: string;
  error?: string;
  endError?: string;
}

/**
 * POST /api/ebay/list-similar
 * Body: { itemIds: string[] }
 *
 * For each item: fetch its full details (GetItem), create a new listing
 * with the same details (AddItem), and — only if that succeeds — end the
 * original (EndItem). An item whose AddItem call fails leaves its original
 * untouched. An item whose AddItem succeeds but EndItem fails is reported
 * with success=true, ended=false so the caller knows to end it manually.
 */
export async function POST(request: NextRequest) {
  try {
    const { itemIds } = await request.json() as { itemIds: string[] };

    if (!itemIds || !Array.isArray(itemIds) || itemIds.length === 0) {
      return NextResponse.json({ error: 'No items provided' }, { status: 400 });
    }

    const token = await getValidToken();

    const results = await Promise.all(
      itemIds.map(async (itemId): Promise<ListSimilarResult> => {
        try {
          const getXml = buildGetItemRequest(itemId, token);
          const getRes = await callEbayApi(getXml, 'GetItem', token);
          const getAck = getRes.match(/<Ack>(.*?)<\/Ack>/)?.[1];
          if (getAck !== 'Success' && getAck !== 'Warning') {
            return { itemId, success: false, ended: false, error: firstErrorMessage(getRes) };
          }

          const itemMatch = getRes.match(/<Item>([\s\S]*)<\/Item>/);
          if (!itemMatch) {
            return { itemId, success: false, ended: false, error: 'Could not parse item details from eBay' };
          }
          const cleanedItemXml = stripDisallowedForAddItem(itemMatch[1]);

          const addXml = buildAddItemRequest(cleanedItemXml, token);
          const addRes = await callEbayApi(addXml, 'AddItem', token);
          const addAck = addRes.match(/<Ack>(.*?)<\/Ack>/)?.[1];
          if (addAck !== 'Success' && addAck !== 'Warning') {
            return { itemId, success: false, ended: false, error: firstErrorMessage(addRes) };
          }

          const newItemId = addRes.match(/<ItemID>(.*?)<\/ItemID>/)?.[1];
          if (!newItemId) {
            return { itemId, success: false, ended: false, error: 'eBay did not return a new item ID' };
          }
          const newItemUrl = buildViewItemUrl(newItemId);

          const endXml = buildEndItemRequest(itemId, token);
          const endRes = await callEbayApi(endXml, 'EndItem', token);
          const endAck = endRes.match(/<Ack>(.*?)<\/Ack>/)?.[1];
          if (endAck !== 'Success' && endAck !== 'Warning') {
            return { itemId, success: true, ended: false, newItemId, newItemUrl, endError: firstErrorMessage(endRes) };
          }

          return { itemId, success: true, ended: true, newItemId, newItemUrl };
        } catch (err: any) {
          return { itemId, success: false, ended: false, error: err.message || 'Network error' };
        }
      })
    );

    return NextResponse.json({ results });
  } catch (err: any) {
    if (err.message === 'EBAY_AUTH_REQUIRED') {
      clearTokenCache();
      return NextResponse.json({ error: 'EBAY_AUTH_REQUIRED' }, { status: 401 });
    }
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}
