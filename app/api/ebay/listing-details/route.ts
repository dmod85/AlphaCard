import { NextRequest, NextResponse } from 'next/server';
import { getValidToken, isOAuthToken, getEbayApiHeaders, getEbayApiUrl, clearTokenCache } from '@/app/lib/ebay-auth';
import { supabaseAdmin } from '@/app/lib/supabase-admin';

function decodeXml(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
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

export interface NameValuePair {
  name: string;
  value: string;
}

function parseSpecifics(xml: string): NameValuePair[] {
  const specifics: NameValuePair[] = [];
  // Use ItemSpecifics block first if available
  const specificsBlock = xml.match(/<ItemSpecifics>([\s\S]*?)<\/ItemSpecifics>/)?.[1] ?? xml;
  const nvRegex = /<NameValueList>([\s\S]*?)<\/NameValueList>/g;
  let m;
  while ((m = nvRegex.exec(specificsBlock)) !== null) {
    const block = m[1];
    const name = decodeXml((block.match(/<Name>(.*?)<\/Name>/)?.[1] || '').trim());
    const value = decodeXml((block.match(/<Value>(.*?)<\/Value>/)?.[1] || '').trim());
    if (name && value) specifics.push({ name, value });
  }
  return specifics;
}

async function fetchSpecificsForItem(
  itemId: string,
  token: string
): Promise<{ itemId: string; specifics: NameValuePair[] }> {
  try {
    const xml = buildGetItemRequest(itemId, token);
    const res = await fetch(getEbayApiUrl(), {
      method: 'POST',
      headers: getEbayApiHeaders('GetItem', token),
      body: xml,
    });
    const text = await res.text();
    const specifics = parseSpecifics(text);
    return { itemId, specifics };
  } catch {
    return { itemId, specifics: [] };
  }
}

/**
 * GET /api/ebay/listing-details?itemIds=123,456,789
 * Returns an array of { itemId, specifics } for each requested item.
 * Specifics are cached in Supabase (ebay_item_specifics) — GetItem is only
 * called for item IDs not already in the cache, since GetSellerList (used to
 * list active listings) doesn't return item specifics at all, and calling
 * GetItem for every listing on every page load quickly exhausts eBay's daily
 * call limit. The cache row is refreshed when an item is revised (see
 * /api/ebay/revise-specifics).
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const raw = searchParams.get('itemIds') || '';
    const itemIds = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 20); // hard cap at 20 per batch

    if (itemIds.length === 0) {
      return NextResponse.json({ error: 'itemIds is required' }, { status: 400 });
    }

    const [{ data: cached }, { data: locks }] = await Promise.all([
      supabaseAdmin.from('ebay_item_specifics').select('item_id, specifics, description_ok').in('item_id', itemIds),
      supabaseAdmin.from('ebay_title_locks').select('item_id').in('item_id', itemIds),
    ]);

    const cachedMap = new Map<string, { specifics: NameValuePair[]; descriptionOk: boolean }>(
      (cached ?? []).map((row) => [
        row.item_id as string,
        {
          specifics: row.specifics as NameValuePair[],
          // description_ok may be null if the column was just added — treat null as false
          descriptionOk: (row.description_ok as boolean | null) ?? false,
        },
      ])
    );
    const lockedIds = new Set((locks ?? []).map((row) => row.item_id as string));
    const uncachedIds = itemIds.filter((id) => !cachedMap.has(id));

    let fetched: { itemId: string; specifics: NameValuePair[] }[] = [];
    if (uncachedIds.length > 0) {
      const token = await getValidToken();
      fetched = await Promise.all(uncachedIds.map((id) => fetchSpecificsForItem(id, token)));

      // New items: description_ok defaults to false (unknown — conservative until revised)
      await supabaseAdmin
        .from('ebay_item_specifics')
        .upsert(
          fetched.map((r) => ({ item_id: r.itemId, specifics: r.specifics, description_ok: false, updated_at: new Date().toISOString() })),
          { onConflict: 'item_id' }
        );
    }

    const results = itemIds.map((id) => {
      const cached = cachedMap.get(id);
      const fetchedItem = fetched.find((r) => r.itemId === id);
      return {
        itemId: id,
        specifics: cached?.specifics ?? fetchedItem?.specifics ?? [],
        descriptionOk: cached?.descriptionOk ?? false,
        titleLocked: lockedIds.has(id),
      };
    });

    return NextResponse.json({ results });
  } catch (err: any) {
    if (err.message === 'EBAY_AUTH_REQUIRED') {
      clearTokenCache();
      return NextResponse.json({ error: 'EBAY_AUTH_REQUIRED' }, { status: 401 });
    }
    return NextResponse.json({ error: err.message || 'Failed to fetch listing details' }, { status: 500 });
  }
}
