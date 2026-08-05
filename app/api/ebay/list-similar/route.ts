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
  <DetailLevel>ItemReturnDescription</DetailLevel>
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
  'OutOfStockControl', 'HideFromSearch', 'ListingDesigner',
];

function stripDisallowedForAddItem(itemXml: string): string {
  let result = itemXml;
  for (const tag of ADD_ITEM_STRIP_TAGS) {
    result = result.replace(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, 'g'), '');
    result = result.replace(new RegExp(`<${tag}(?:\\s[^>]*)?\\/>`, 'g'), '');
  }
  return result;
}

// As of schema 997, eBay moved the physical-package fields off
// ShippingDetails.CalculatedShippingRate onto their own top-level
// Item.ShippingPackageDetails block. GetItem still echoes the old nested
// copies for backwards compatibility, but AddItem now rejects them there —
// unlike the flat ADD_ITEM_STRIP_TAGS list above, these tag names are also
// legitimate at the top level (inside ShippingPackageDetails), so they can
// only be stripped from this specific nested location, not globally.
const CALCULATED_SHIPPING_RATE_DEPRECATED_TAGS = [
  'WeightMajor', 'WeightMinor', 'PackageDepth', 'PackageLength', 'PackageWidth',
  'ShippingIrregular', 'ShippingPackage',
];

function stripDeprecatedCalculatedShippingRateFields(itemXml: string): string {
  return itemXml.replace(/<CalculatedShippingRate>([\s\S]*?)<\/CalculatedShippingRate>/, (_match, inner) => {
    let cleaned = inner;
    for (const tag of CALCULATED_SHIPPING_RATE_DEPRECATED_TAGS) {
      cleaned = cleaned.replace(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, 'g'), '');
      cleaned = cleaned.replace(new RegExp(`<${tag}(?:\\s[^>]*)?\\/>`, 'g'), '');
    }
    return `<CalculatedShippingRate>${cleaned}</CalculatedShippingRate>`;
  });
}

// eBay keeps deprecating individual Item fields out from under GetItem's
// response (OutOfStockControl, ListingDesigner, nested shipping weights, …) —
// each one only surfaces once we hit it in production. Rather than patching
// ADD_ITEM_STRIP_TAGS one field at a time forever, parse eBay's own
// "AddItemRequest.Item.X.Y.Z is deprecated" errors and strip whatever it
// names, then retry — so a newly-deprecated field self-heals instead of
// failing every "List Similar" run until the next code change.
const DEPRECATED_FIELD_RETRY_LIMIT = 5;

function extractDeprecatedFieldPaths(errorXml: string): string[] {
  const paths: string[] = [];
  const regex = /input object "AddItemRequest\.Item\.([^"]+)" is deprecated/g;
  let m;
  while ((m = regex.exec(errorXml)) !== null) paths.push(m[1]);
  return paths;
}

function stripTag(xml: string, tag: string): string {
  return xml
    .replace(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, 'g'), '')
    .replace(new RegExp(`<${tag}(?:\\s[^>]*)?\\/>`, 'g'), '');
}

// path looks like "ShippingDetails.CalculatedShippingRate.WeightMajor" or
// just "ListingDesigner" — scope the strip to the immediate parent element
// when there is one, since some leaf tag names (e.g. WeightMajor) are also
// legitimate elsewhere in the document at a different nesting level.
function stripDeprecatedFieldAtPath(itemXml: string, path: string): string {
  const segments = path.split('.');
  const leaf = segments[segments.length - 1];
  if (segments.length === 1) return stripTag(itemXml, leaf);

  const parent = segments[segments.length - 2];
  const parentRegex = new RegExp(`<${parent}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${parent}>`);
  const match = itemXml.match(parentRegex);
  if (!match) return itemXml;
  return itemXml.replace(parentRegex, `<${parent}>${stripTag(match[1], leaf)}</${parent}>`);
}

/**
 * Calls AddItem, auto-stripping and retrying on any newly-deprecated field
 * errors eBay reports (see extractDeprecatedFieldPaths above). Returns the
 * final response/ack plus the item XML as of the last attempt, so a caller
 * retrying after an EndItem fallback can start from whatever was already
 * learned instead of rediscovering the same deprecated fields again.
 */
async function attemptAddItem(
  itemId: string,
  itemXml: string,
  token: string
): Promise<{ addRes: string; addAck: string | undefined; itemXml: string }> {
  let cleanedItemXml = itemXml;
  let addRes = '';
  let addAck: string | undefined;
  for (let attempt = 0; attempt <= DEPRECATED_FIELD_RETRY_LIMIT; attempt++) {
    addRes = await callEbayApi(buildAddItemRequest(cleanedItemXml, token), 'AddItem', token);
    addAck = addRes.match(/<Ack>(.*?)<\/Ack>/)?.[1];
    if (addAck === 'Success' || addAck === 'Warning') break;

    const deprecatedPaths = extractDeprecatedFieldPaths(addRes);
    if (deprecatedPaths.length === 0 || attempt === DEPRECATED_FIELD_RETRY_LIMIT) break;

    console.warn(`[list-similar] ${itemId}: auto-stripping newly-deprecated field(s): ${deprecatedPaths.join(', ')}`);
    for (const path of deprecatedPaths) {
      cleanedItemXml = stripDeprecatedFieldAtPath(cleanedItemXml, path);
    }
  }
  return { addRes, addAck, itemXml: cleanedItemXml };
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
 * For each item: fetch its full details (GetItem), then try the SAFE order
 * first — create the replacement (AddItem) while the original is still
 * live, then end the original (EndItem). If AddItem fails there (e.g. eBay's
 * "identical item" duplicate policy blocking a second live copy of the same
 * item), fall back to ending the original first and retrying AddItem once
 * more — which sidesteps that conflict, but is riskier: if the fallback's
 * AddItem also fails, the item is left unlisted with nothing to replace it.
 *
 * Result semantics:
 * - success=true, ended=true: replacement is live, original ended. Best case.
 * - success=true, ended=false: replacement is live, but ending the original
 *   failed (endError set) — a harmless duplicate now exists; end it manually.
 * - success=false, ended=false: nothing happened — safe to just retry.
 * - success=false, ended=true: CRITICAL — original ended, replacement never
 *   went live. Caller must treat this as urgent (item is now unlisted).
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
        let ended = false;
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
          const initialItemXml = stripDeprecatedCalculatedShippingRateFields(stripDisallowedForAddItem(itemMatch[1]));

          // 1. Safe order: create while the original is still live. Zero risk
          // if this fails — the original is untouched.
          const firstAttempt = await attemptAddItem(itemId, initialItemXml, token);

          if (firstAttempt.addAck === 'Success' || firstAttempt.addAck === 'Warning') {
            const newItemId = firstAttempt.addRes.match(/<ItemID>(.*?)<\/ItemID>/)?.[1];
            if (!newItemId) {
              return { itemId, success: false, ended: false, error: 'eBay did not return a new item ID' };
            }
            const newItemUrl = buildViewItemUrl(newItemId);

            const endRes = await callEbayApi(buildEndItemRequest(itemId, token), 'EndItem', token);
            const endAck = endRes.match(/<Ack>(.*?)<\/Ack>/)?.[1];
            if (endAck !== 'Success' && endAck !== 'Warning') {
              return { itemId, success: true, ended: false, newItemId, newItemUrl, endError: firstErrorMessage(endRes) };
            }
            return { itemId, success: true, ended: true, newItemId, newItemUrl };
          }

          // 2. Fallback: the safe-order create failed — end the original and
          // retry once more, picking up from whatever fields the first
          // attempt already learned were deprecated. From here on, a failure
          // is critical: the original is gone with nothing yet to replace it.
          const firstAddError = firstErrorMessage(firstAttempt.addRes);

          const endRes = await callEbayApi(buildEndItemRequest(itemId, token), 'EndItem', token);
          const endAck = endRes.match(/<Ack>(.*?)<\/Ack>/)?.[1];
          if (endAck !== 'Success' && endAck !== 'Warning') {
            // Nothing changed — surface the original create failure, it's the root cause.
            return { itemId, success: false, ended: false, error: firstAddError };
          }
          ended = true;

          const retryAttempt = await attemptAddItem(itemId, firstAttempt.itemXml, token);
          if (retryAttempt.addAck !== 'Success' && retryAttempt.addAck !== 'Warning') {
            return { itemId, success: false, ended: true, error: firstErrorMessage(retryAttempt.addRes) };
          }

          const newItemId = retryAttempt.addRes.match(/<ItemID>(.*?)<\/ItemID>/)?.[1];
          if (!newItemId) {
            return { itemId, success: false, ended: true, error: 'eBay did not return a new item ID' };
          }
          return { itemId, success: true, ended: true, newItemId, newItemUrl: buildViewItemUrl(newItemId) };
        } catch (err: any) {
          return { itemId, success: false, ended, error: err.message || 'Network error' };
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
