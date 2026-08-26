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
  type SaleRow,
} from '@/app/lib/ebay-orders';
import { applyCostDefaultsToRow } from '@/app/lib/pnl';
import { fetchSellerLabelCosts } from '@/app/lib/ebay-finances';

// -----------------------------------------------------------------------
// eBay Trading API: GetOrders with OrderStatus=Completed
// Pulls sold orders, upserts into ebay_sales, returns all DB rows.
//
// GET  /api/ebay/sold-orders          — sync from eBay + return DB rows
//   ?days=90   — lookback in days (default 90, max 90 per eBay limit)
//   ?page=1    — single eBay page (omit to walk every page in the lookback)
//   ?sync=false — skip eBay call, just return DB rows
//
// Existing sales keep their SKU/ads/supplies. eBay fee + shipping_cost are
// overwritten from GetOrders whenever those fields are present.
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
    const pageParam = searchParams.get('page');
    const startPage = parseInt(pageParam || '1', 10);
    const fetchAllPages = pageParam == null;
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
    const fromIso = fromDate.toISOString();
    const toIso = toDate.toISOString();

    const fetchOrdersPage = async (pageNum: number) => {
      const xml = buildGetOrdersRequest(fromIso, toIso, pageNum, token);
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
          const err = new Error('EBAY_AUTH_REQUIRED');
          (err as any).ebayAuth = true;
          throw err;
        }
        throw new Error(decodeXml(errMsg));
      }
      const pages = parseInt(
        responseXml.match(/<TotalNumberOfPages>(.*?)<\/TotalNumberOfPages>/)?.[1] || '1'
      );
      return { rows: parseOrders(responseXml), pages };
    };

    let totalPages = 1;
    const rows: SaleRow[] = [];
    try {
      let currentPage = startPage;
      do {
        const result = await fetchOrdersPage(currentPage);
        totalPages = result.pages;
        rows.push(...result.rows);
        currentPage += 1;
      } while (fetchAllPages && currentPage <= totalPages);
    } catch (err: any) {
      if (err.ebayAuth || err.message === 'EBAY_AUTH_REQUIRED') {
        return NextResponse.json({ error: 'EBAY_AUTH_REQUIRED' }, { status: 401 });
      }
      return NextResponse.json({ error: err.message || 'eBay API error' }, { status: 500 });
    }

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

    // Seller-paid eBay labels live in Finances, not GetOrders.ActualShippingCost
    // (that's buyer-paid). Look a few days past the sales window — labels are
    // usually bought after the order is created.
    const labelFrom = new Date(fromDate);
    labelFrom.setDate(labelFrom.getDate() - 1);
    const labelTo = new Date(toDate);
    labelTo.setDate(labelTo.getDate() + 14);
    const { byOrderId: labelCosts, error: financesError } = await fetchSellerLabelCosts(
      labelFrom.toISOString(),
      labelTo.toISOString()
    );

    const postageAssigned = new Set<string>();
    for (const r of uniqueRows) {
      const financed = labelCosts.get(r.order_number);
      if (financed != null) {
        r.shipping_cost = postageAssigned.has(r.order_number) ? 0 : financed;
        postageAssigned.add(r.order_number);
        continue;
      }
      if (postageAssigned.has(r.order_number)) {
        r.shipping_cost = 0;
        continue;
      }
      postageAssigned.add(r.order_number);
      // keep pickSellerShippingCost (eBay label estimate / GSP only) or null
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

      // Overwrite eBay fee + seller postage. shipping_cost is always written
      // (including null) so previously saved *buyer-paid* ActualShippingCost
      // values get cleared when we don't have a seller-paid label charge.
      let costsUpdated = 0;
      const CHUNK = 15;
      for (let i = 0; i < uniqueRows.length; i += CHUNK) {
        const chunk = uniqueRows.slice(i, i + CHUNK);
        const counts = await Promise.all(
          chunk.map(async (r) => {
            const patch: Record<string, number | null> = {
              shipping_cost: r.shipping_cost,
            };
            if (r.ebay_fee != null) patch.ebay_fee = r.ebay_fee;
            let q = supabaseAdmin
              .from('ebay_sales')
              .update(patch)
              .eq('order_number', r.order_number);
            if (r.ebay_item_id) q = q.eq('ebay_item_id', r.ebay_item_id);
            const { data, error } = await q.select('id');
            if (error) {
              console.error('[sold-orders] cost refresh:', error.message);
              return 0;
            }
            return data?.length ?? 0;
          })
        );
        costsUpdated += counts.reduce((a, b) => a + b, 0);
      }

      const { data: allSales, error: fetchErr } = await supabaseAdmin
        .from('ebay_sales')
        .select('*')
        .order('sale_date', { ascending: false });
      if (fetchErr) throw fetchErr;

      return NextResponse.json({
        sales: allSales ?? [],
        synced,
        costsUpdated,
        financesError,
        totalPages,
        currentPage: fetchAllPages ? totalPages : startPage,
      });
    }

    // No new rows from eBay — still return DB
    const { data: allSales, error: fetchErr } = await supabaseAdmin
      .from('ebay_sales')
      .select('*')
      .order('sale_date', { ascending: false });
    if (fetchErr) throw fetchErr;

    return NextResponse.json({
      sales: allSales ?? [],
      synced: 0,
      costsUpdated: 0,
      financesError,
      totalPages,
      currentPage: fetchAllPages ? totalPages : startPage,
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
