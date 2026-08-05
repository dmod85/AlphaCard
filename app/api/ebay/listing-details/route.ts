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
  <IncludeWatchCount>true</IncludeWatchCount>
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
</GetItemRequest>`;
}

// Watcher counts change constantly, unlike specifics (which only change when
// we explicitly revise them) — so a cached row is only "fresh enough" to skip
// a GetItem call for this long before we re-fetch to keep the count current.
const STATS_TTL_MS = 60 * 60 * 1000; // 1 hour

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
): Promise<{ itemId: string; specifics: NameValuePair[]; watchCount: number | null }> {
  try {
    const xml = buildGetItemRequest(itemId, token);
    const res = await fetch(getEbayApiUrl(), {
      method: 'POST',
      headers: getEbayApiHeaders('GetItem', token),
      body: xml,
    });
    const text = await res.text();
    const specifics = parseSpecifics(text);
    const watchCountRaw = text.match(/<WatchCount>(.*?)<\/WatchCount>/)?.[1];
    const watchCount = watchCountRaw !== undefined ? parseInt(watchCountRaw, 10) : null;
    return { itemId, specifics, watchCount };
  } catch {
    return { itemId, specifics: [], watchCount: null };
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

    const [{ data: cached }, { data: locks }, { data: hidden }] = await Promise.all([
      supabaseAdmin.from('ebay_item_specifics').select('item_id, specifics, description_ok, watch_count, stats_updated_at').in('item_id', itemIds),
      supabaseAdmin.from('ebay_title_locks').select('item_id').in('item_id', itemIds),
      supabaseAdmin.from('ebay_hidden_listings').select('item_id').in('item_id', itemIds),
    ]);

    const cachedMap = new Map<string, {
      specifics: NameValuePair[];
      descriptionOk: boolean;
      watchCount: number | null;
      statsUpdatedAt: string | null;
    }>(
      (cached ?? []).map((row) => [
        row.item_id as string,
        {
          specifics: row.specifics as NameValuePair[],
          // description_ok may be null if the column was just added — treat null as false
          descriptionOk: (row.description_ok as boolean | null) ?? false,
          watchCount: row.watch_count as number | null,
          statsUpdatedAt: row.stats_updated_at as string | null,
        },
      ])
    );
    const lockedIds = new Set((locks ?? []).map((row) => row.item_id as string));
    const hiddenIds = new Set((hidden ?? []).map((row) => row.item_id as string));

    // Fetch (or re-fetch) when we've never seen the item, or its watcher count
    // is past the TTL — specifics themselves don't force a re-fetch, but come
    // along for free (and get refreshed too) whenever stats do.
    const now = Date.now();
    const idsNeedingFetch = itemIds.filter((id) => {
      const row = cachedMap.get(id);
      if (!row) return true;
      if (!row.statsUpdatedAt) return true;
      return now - new Date(row.statsUpdatedAt).getTime() > STATS_TTL_MS;
    });

    let fetched: { itemId: string; specifics: NameValuePair[]; watchCount: number | null }[] = [];
    if (idsNeedingFetch.length > 0) {
      const token = await getValidToken();
      fetched = await Promise.all(idsNeedingFetch.map((id) => fetchSpecificsForItem(id, token)));

      const nowIso = new Date().toISOString();
      await supabaseAdmin
        .from('ebay_item_specifics')
        .upsert(
          fetched.map((r) => ({
            item_id: r.itemId,
            specifics: r.specifics,
            // Preserve description_ok for items we already knew about — only
            // brand-new rows default it to false (unknown until revised).
            description_ok: cachedMap.get(r.itemId)?.descriptionOk ?? false,
            watch_count: r.watchCount,
            stats_updated_at: nowIso,
            updated_at: nowIso,
          })),
          { onConflict: 'item_id' }
        );
    }

    const results = itemIds.map((id) => {
      const cached = cachedMap.get(id);
      const fetchedItem = fetched.find((r) => r.itemId === id);
      return {
        itemId: id,
        specifics: fetchedItem?.specifics ?? cached?.specifics ?? [],
        descriptionOk: cached?.descriptionOk ?? false,
        titleLocked: lockedIds.has(id),
        hidden: hiddenIds.has(id),
        watchCount: fetchedItem?.watchCount ?? cached?.watchCount ?? null,
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
