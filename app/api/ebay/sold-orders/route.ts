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
import { applySellerLabelCosts } from '@/app/lib/ebay-label-costs';
import { clearEstimatedAdFees } from '@/app/lib/clear-estimated-ads';
import { setSalesExcluded, withExclusionFlags } from '@/app/lib/sale-exclusions';

// -----------------------------------------------------------------------
// eBay Trading API: GetOrders with OrderStatus=Completed
// Pulls sold orders, upserts into ebay_sales, returns all DB rows.
//
// GET  /api/ebay/sold-orders          — sync from eBay + return DB rows
//   ?days=90   — lookback in days (default 90, max 90 per eBay limit)
//   ?page=1    — single eBay page (omit to walk every page in the lookback)
//   ?sync=false — skip eBay call, just return DB rows
//
// Existing sales keep SKU/supplies. eBay fee is backfilled from GetOrders
// FinalValueFee when present. Promoted-listing ads and seller-paid postage
// stay null until Finances posts them (eSE labels often land hours later).
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

    // Drop leftover 16% ad estimates so ROI only counts Finances-reported ads.
    try {
      await clearEstimatedAdFees();
    } catch (err: any) {
      console.error('[sold-orders] clear ads:', err?.message || err);
    }

    // If not syncing, just return DB rows
    if (!shouldSync) {
      const { data, error } = await supabaseAdmin
        .from('ebay_sales')
        .select('*')
        .order('sale_date', { ascending: false });
      if (error) throw error;
      return NextResponse.json({ sales: await withExclusionFlags(data ?? []), synced: 0 });
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

    const settings = await loadPnlSettings();
    const rowsWithCosts = uniqueRows.map((r) => applyCostDefaultsToRow(r, settings));

    // Insert only NEW rows — ignoreDuplicates:true skips existing (order_number, ebay_item_id)
    // so we never overwrite manually-edited SKUs / costs and the synced count reflects truly new rows.
    let synced = 0;
    let feesUpdated = 0;
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

      // Backfill fee + identity fields on existing rows. Seller postage comes
      // from Finances (postpaid eSE labels) via applySellerLabelCosts below.
      const CHUNK = 15;
      for (let i = 0; i < uniqueRows.length; i += CHUNK) {
        const chunk = uniqueRows.slice(i, i + CHUNK);
        const counts = await Promise.all(
          chunk.map(async (r) => {
            const patch: Record<string, unknown> = {};
            if (r.ebay_fee != null) patch.ebay_fee = r.ebay_fee;
            if (r.buyer) patch.buyer = r.buyer;
            if (r.sales_record_number) patch.sales_record_number = r.sales_record_number;
            if (r.shipping_service) patch.shipping_service = r.shipping_service;
            if (r.tracking_number) patch.tracking_number = r.tracking_number;
            if (r.shipped_at) patch.shipped_at = r.shipped_at;
            if (Object.keys(patch).length === 0) return 0;
            let q = supabaseAdmin
              .from('ebay_sales')
              .update(patch)
              .eq('order_number', r.order_number);
            if (r.ebay_item_id) q = q.eq('ebay_item_id', r.ebay_item_id);
            const { data, error } = await q.select('id');
            if (error) {
              console.error('[sold-orders] fee refresh:', error.message);
              return 0;
            }
            return data?.length ?? 0;
          })
        );
        feesUpdated += counts.reduce((a, b) => a + b, 0);
      }
    }

    // Postpaid shipping-label fees often land after GetOrders. Scan Finances
    // for at least 14 days so yesterday's eSE charges match today's payouts.
    let labelsMatched = 0;
    try {
      const labelResult = await applySellerLabelCosts({
        days: Math.max(days, 14),
        quick: true,
        onlyBlank: true,
      });
      labelsMatched = labelResult.matchedOrders;
      return NextResponse.json({
        sales: await withExclusionFlags(labelResult.sales as Array<{ id: string }>),
        synced,
        feesUpdated,
        labelsMatched,
        totalPages,
        currentPage: fetchAllPages ? totalPages : startPage,
      });
    } catch (labelErr: any) {
      console.error('[sold-orders] label costs:', labelErr?.message || labelErr);
    }

    const { data: allSales, error: fetchErr } = await supabaseAdmin
      .from('ebay_sales')
      .select('*')
      .order('sale_date', { ascending: false });
    if (fetchErr) throw fetchErr;

    return NextResponse.json({
      sales: await withExclusionFlags(allSales ?? []),
      synced,
      feesUpdated,
      labelsMatched,
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
// PATCH handler — update sku, costs, or exclude_from_stats
// body: { id | ids, sku?, ebay_fee?, advertising_fee?, shipping_cost?, supplies_cost?, exclude_from_stats? }
// -----------------------------------------------------------------------
const PATCH_MONEY_FIELDS = ['ebay_fee', 'advertising_fee', 'shipping_cost', 'supplies_cost'] as const;

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, ids, sku } = body;
    if (!id && (!ids || ids.length === 0)) {
      return NextResponse.json({ error: 'id or ids required' }, { status: 400 });
    }

    const targetIds: string[] = ids && ids.length > 0 ? ids.map(String) : [String(id)];

    if (body.exclude_from_stats !== undefined && sku === undefined && !PATCH_MONEY_FIELDS.some((f) => body[f] !== undefined)) {
      await setSalesExcluded(targetIds, !!body.exclude_from_stats);
      return NextResponse.json({ ok: true, ids: targetIds, exclude_from_stats: !!body.exclude_from_stats });
    }

    const updates: Record<string, unknown> = {};
    if (sku !== undefined) updates.sku = sku || null;
    for (const field of PATCH_MONEY_FIELDS) {
      if (body[field] !== undefined) {
        updates[field] = body[field] === null || body[field] === '' ? null : parseFloat(body[field]);
      }
    }
    if (body.exclude_from_stats !== undefined) {
      await setSalesExcluded(targetIds, !!body.exclude_from_stats);
    }
    if (body.pool_item_id !== undefined) {
      try {
        for (const saleId of targetIds) {
          await supabaseAdmin
            .from('purchase_pool_items')
            .update({ sale_id: null, status: 'listed' })
            .eq('sale_id', saleId);
          if (body.pool_item_id) {
            const { error: itemErr } = await supabaseAdmin
              .from('purchase_pool_items')
              .update({ sale_id: saleId, status: 'sold' })
              .eq('id', body.pool_item_id);
            if (itemErr) throw itemErr;
          }
        }
      } catch (itemErr: any) {
        if (!/purchase_pool_items/i.test(itemErr?.message || '')) throw itemErr;
      }
    }
    if (Object.keys(updates).length === 0) {
      if (body.exclude_from_stats !== undefined || body.pool_item_id !== undefined) {
        return NextResponse.json({
          ok: true,
          ids: targetIds,
          exclude_from_stats: body.exclude_from_stats,
          pool_item_id: body.pool_item_id ?? null,
        });
      }
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
