import { NextRequest, NextResponse } from 'next/server';
import {
  getValidToken,
  getEbayApiHeaders,
  getEbayApiUrl,
  clearTokenCache,
} from '@/app/lib/ebay-auth';
import { supabaseAdmin } from '@/app/lib/supabase-admin';
import {
  isEbayAuthError,
  decodeXml,
  buildGetOrdersRequest,
  parseOrders,
  fetchImagesForItems,
  loadPnlSettings,
} from '@/app/lib/ebay-orders';
import { applyCostDefaultsToRow } from '@/app/lib/pnl';

// -----------------------------------------------------------------------
// eBay Trading API: GetOrders with OrderStatus=Completed
// Pulls sold orders, upserts into ebay_sales, returns all DB rows.
//
// GET  /api/ebay/sold-orders          — sync from eBay + return DB rows
//   ?days=90   — lookback in days (default 90, max 90 per eBay limit)
//   ?page=1    — eBay page of results
//   ?sync=false — skip eBay call, just return DB rows
//
// PATCH /api/ebay/sold-orders         — update a single sale's SKU
//   body: { id, sku }
// -----------------------------------------------------------------------
// GET handler — sync from eBay and/or return DB rows
// -----------------------------------------------------------------------
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const days = Math.min(parseInt(searchParams.get('days') || '90', 10), 90);
    const page = parseInt(searchParams.get('page') || '1', 10);
    const shouldSync = searchParams.get('sync') !== 'false';

    // If not syncing, just return DB rows
    if (!shouldSync) {
      const { data, error } = await supabaseAdmin
        .from('ebay_sales')
        .select('*')
        .order('sale_date', { ascending: false });
      if (error) throw error;
      return NextResponse.json({ sales: data ?? [], synced: 0 });
    }

    // Build date range:
    // toDate   = right now
    // fromDate = midnight (start of day) X days ago — so the full day is included
    const toDate = new Date();
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - days);
    fromDate.setHours(0, 0, 0, 0); // include the entire starting day

    const token = await getValidToken();
    const xml = buildGetOrdersRequest(
      fromDate.toISOString(),
      toDate.toISOString(),
      page,
      token
    );

    const res = await fetch(getEbayApiUrl(), {
      method: 'POST',
      headers: getEbayApiHeaders('GetOrders', token),
      body: xml,
    });
    const responseXml = await res.text();

    const ack = responseXml.match(/<Ack>(.*?)<\/Ack>/)?.[1];
    if (ack === 'Failure') {
      const errMsg =
        responseXml.match(/<LongMessage>(.*?)<\/LongMessage>/)?.[1] ||
        responseXml.match(/<ShortMessage>(.*?)<\/ShortMessage>/)?.[1] ||
        'eBay API error';
      console.error('[sold-orders] eBay API failure:', decodeXml(errMsg));
      if (isEbayAuthError(responseXml)) {
        clearTokenCache();
        return NextResponse.json({ error: 'EBAY_AUTH_REQUIRED' }, { status: 401 });
      }
      return NextResponse.json({ error: decodeXml(errMsg) }, { status: 500 });
    }

    const totalPages = parseInt(
      responseXml.match(/<TotalNumberOfPages>(.*?)<\/TotalNumberOfPages>/)?.[1] || '1'
    );

    const rows = parseOrders(responseXml);

    // Deduplicate within the batch — Postgres raises an error if the same
    // conflict key appears more than once in a single upsert payload.
    const seen = new Set<string>();
    const uniqueRows = rows.filter(r => {
      const key = `${r.order_number}||${r.ebay_item_id ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Fetch images for valid ItemIDs via Shopping API
    const realItemIds = Array.from(new Set(
      uniqueRows
        .map(r => r.ebay_item_id)
        .filter((id): id is string => id !== null && !id.startsWith('synthetic-'))
    ));

    if (realItemIds.length > 0) {
      const imageMap = await fetchImagesForItems(realItemIds);
      for (const row of uniqueRows) {
        if (row.ebay_item_id && imageMap[row.ebay_item_id]) {
          row.picture_url = imageMap[row.ebay_item_id];
        }
      }
    }

    const settings = await loadPnlSettings();
    const rowsWithCosts = uniqueRows.map((r) => applyCostDefaultsToRow(r, settings));

    // Insert only NEW rows — ignoreDuplicates:true skips existing (order_number, ebay_item_id)
    // so we never overwrite manually-edited SKUs / costs and the synced count reflects truly new rows.
    let synced = 0;
    if (rowsWithCosts.length > 0) {
      const { data: inserted, error: upsertError } = await supabaseAdmin
        .from('ebay_sales')
        .upsert(
          rowsWithCosts.map((r) => ({ ...r, synced_at: new Date().toISOString() })),
          { onConflict: 'order_number,ebay_item_id', ignoreDuplicates: true }
        )
        .select('id');
      if (upsertError) {
        console.error('[sold-orders] upsert error:', upsertError.message);
      } else {
        // Only rows actually inserted (not skipped) are returned when ignoreDuplicates:true
        synced = inserted?.length ?? 0;
      }

      // Backfill eBay final-value fees on existing rows that still have a null fee.
      const withParsedFee = uniqueRows.filter((r) => r.ebay_fee != null);
      for (const r of withParsedFee) {
        let q = supabaseAdmin
          .from('ebay_sales')
          .update({ ebay_fee: r.ebay_fee })
          .eq('order_number', r.order_number)
          .is('ebay_fee', null);
        if (r.ebay_item_id) q = q.eq('ebay_item_id', r.ebay_item_id);
        await q;
      }
    }

    // Return all DB rows (not just the synced page)
    const { data: allSales, error: fetchErr } = await supabaseAdmin
      .from('ebay_sales')
      .select('*')
      .order('sale_date', { ascending: false });
    if (fetchErr) throw fetchErr;

    return NextResponse.json({
      sales: allSales ?? [],
      synced,
      totalPages,
      currentPage: page,
    });
  } catch (err: any) {
    if (err.message === 'EBAY_AUTH_REQUIRED') {
      return NextResponse.json({ error: 'EBAY_AUTH_REQUIRED' }, { status: 401 });
    }
    return NextResponse.json(
      { error: err.message || 'Internal server error' },
      { status: 500 }
    );
  }
}

// -----------------------------------------------------------------------
// PATCH handler — update sku and/or per-sale cost fields
// body: { id | ids, sku?, ebay_fee?, advertising_fee?, shipping_cost?, supplies_cost? }
// -----------------------------------------------------------------------
const PATCH_MONEY_FIELDS = ['ebay_fee', 'advertising_fee', 'shipping_cost', 'supplies_cost'] as const;

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, ids, sku } = body;
    if (!id && (!ids || ids.length === 0)) {
      return NextResponse.json({ error: 'id or ids required' }, { status: 400 });
    }

    const updates: Record<string, unknown> = {};
    if (sku !== undefined) updates.sku = sku || null;
    for (const field of PATCH_MONEY_FIELDS) {
      if (body[field] !== undefined) {
        updates[field] = body[field] === null || body[field] === '' ? null : parseFloat(body[field]);
      }
    }
    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'no fields to update' }, { status: 400 });
    }

    let query = supabaseAdmin.from('ebay_sales').update(updates);

    if (ids && ids.length > 0) {
      query = query.in('id', ids);
    } else {
      query = query.eq('id', id);
    }

    const { data, error } = await query.select();

    if (error) throw error;
    return NextResponse.json({ sales: data });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
