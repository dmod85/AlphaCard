import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabase-admin';
import { ebayApiRoot, getAppAccessToken } from '@/app/lib/ebay-app-token';
import { findSoldComps } from '@/app/lib/card-listing/claude';
import { suggestPrice } from '@/app/lib/card-listing/pricing';
import type { ActiveComp, CompsResult, GeneratedListing, OwnSale } from '@/app/lib/card-listing/schema';

export const maxDuration = 120;

// Active eBay listings for the same card via the Browse API (app token, so it
// works even when the seller's user token has expired).
async function fetchActive(query: string): Promise<ActiveComp[]> {
  const token = await getAppAccessToken();
  const params = new URLSearchParams({
    q: query,
    category_ids: '261328',
    filter: 'buyingOptions:{FIXED_PRICE}',
    limit: '12',
  });
  const res = await fetch(`${ebayApiRoot()}/buy/browse/v1/item_summary/search?${params}`, {
    headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' },
  });
  if (!res.ok) throw new Error(`eBay Browse API error ${res.status}`);
  const data = await res.json();
  return (data?.itemSummaries ?? [])
    .map((item: any) => ({
      title: item.title ?? '',
      price: parseFloat(item.price?.value ?? '0'),
      url: item.itemWebUrl ?? '',
      image_url: item.thumbnailImages?.[0]?.imageUrl ?? item.image?.imageUrl ?? null,
    }))
    .filter((c: ActiveComp) => c.price > 0)
    .sort((a: ActiveComp, b: ActiveComp) => a.price - b.price);
}

// Your own past eBay sales of the same player (+ year when known).
async function fetchOwnSales(listing: GeneratedListing): Promise<OwnSale[]> {
  const player = listing.card.player_names[0]?.trim();
  if (!player) return [];
  let q = supabaseAdmin
    .from('ebay_sales')
    .select('item_title, sold_for, sale_date')
    .ilike('item_title', `%${player.replace(/[%_]/g, '')}%`)
    .gt('sold_for', 0)
    .order('sale_date', { ascending: false })
    .limit(10);
  const year = listing.card.year?.match(/\d{4}/)?.[0];
  if (year) q = q.ilike('item_title', `%${year}%`);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []).map(r => ({ title: r.item_title, price: Number(r.sold_for), sold_date: r.sale_date }));
}

function errorMessage(r: PromiseSettledResult<unknown>): string | null {
  return r.status === 'rejected' ? (r.reason?.message ?? String(r.reason)) : null;
}

// POST { listing: GeneratedListing } → CompsResult
export async function POST(request: NextRequest) {
  try {
    const { listing } = (await request.json()) as { listing?: GeneratedListing };
    if (!listing?.comp_search_query || !listing.card) {
      return NextResponse.json({ error: 'Missing listing' }, { status: 400 });
    }

    const [soldR, activeR, ownR] = await Promise.allSettled([
      findSoldComps(listing),
      fetchActive(listing.comp_search_query),
      fetchOwnSales(listing),
    ]);

    const sold = soldR.status === 'fulfilled' ? soldR.value.comps : [];
    const active = activeR.status === 'fulfilled' ? activeR.value : [];
    if (ownR.status === 'rejected') console.error('[listing-generator/comps] own sales:', ownR.reason);

    const result: CompsResult = {
      sold,
      sold_notes: soldR.status === 'fulfilled' ? soldR.value.notes : null,
      sold_error: errorMessage(soldR),
      active,
      active_error: errorMessage(activeR),
      own_sales: ownR.status === 'fulfilled' ? ownR.value : [],
      price: suggestPrice(sold, active),
    };
    return NextResponse.json(result);
  } catch (err: any) {
    console.error('[listing-generator/comps] error:', err);
    return NextResponse.json({ error: err.message || 'Failed to fetch comps' }, { status: 500 });
  }
}
