import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabase-admin';
import { parseAllocationMode } from '@/app/lib/pool-roi';

const ITEM_SELECT = '*, items:purchase_pool_items(*)';

// -----------------------------------------------------------------------
// GET /api/purchases
// Returns all purchase rows (with pool line items), grouped by sku on the client.
// Optional query params:
//   ?q=<search>     — filters by sku, brand, series, sport (ilike)
//   ?sku=<sku>      — filter to a specific sku
// -----------------------------------------------------------------------
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const q = searchParams.get('q')?.trim();
    const skuFilter = searchParams.get('sku')?.trim();

    const run = async (select: string) => {
      let query = supabaseAdmin
        .from('card_purchases')
        .select(select)
        .order('purchase_date', { ascending: false })
        .order('created_at', { ascending: false });

      if (skuFilter) {
        query = query.eq('sku', skuFilter);
      } else if (q) {
        query = query.or(
          `sku.ilike.%${q}%,brand.ilike.%${q}%,series.ilike.%${q}%,sport.ilike.%${q}%,bought_from.ilike.%${q}%`
        );
      }

      return query;
    };

    let { data, error } = await run(ITEM_SELECT);
    if (error && /purchase_pool_items|allocation_mode|expected_bulk_recovery/i.test(error.message || '')) {
      ({ data, error } = await run('*'));
    }
    if (error) {
      console.error('[purchases GET] Supabase error:', error.code, error.message);
      throw error;
    }

    const purchases = (data ?? []).map(withDefaultPoolFields);
    return NextResponse.json({ purchases });
  } catch (err: any) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 500 });
  }
}

// -----------------------------------------------------------------------
// POST /api/purchases
// Create one or more purchase rows.
// Body: single purchase object OR { rows: [...] } for CSV bulk import.
// Optional `items` array on a single create.
// -----------------------------------------------------------------------
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // Bulk import path: { rows: [...] }
    if (body.rows && Array.isArray(body.rows)) {
      const rows = body.rows.map(sanitize);
      let { data, error } = await supabaseAdmin.from('card_purchases').insert(rows).select();
      if (error && isMissingPoolColumn(error)) {
        ({ data, error } = await supabaseAdmin
          .from('card_purchases')
          .insert(rows.map(stripPoolColumns))
          .select());
      }
      if (error) throw error;
      return NextResponse.json({ purchases: (data ?? []).map(withDefaultPoolFields) });
    }

    // Single row
    const { items, ...rest } = body;
    const row = sanitize(rest);
    const { data, error } = await insertPurchase(row);
    if (error) throw error;
    if (!data) throw new Error('insert failed');
    if (Array.isArray(items) && data?.id) {
      try {
        await replaceItems(data.id, items);
      } catch (itemErr: any) {
        if (!/purchase_pool_items/i.test(itemErr?.message || '')) throw itemErr;
      }
    }
    const purchase = await loadPurchase(data.id);
    return NextResponse.json({ purchase: purchase ?? withDefaultPoolFields(data) });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// -----------------------------------------------------------------------
// PATCH /api/purchases
// Update an existing purchase row by id.
// Body: { id, ...fields, items? }
// -----------------------------------------------------------------------
export async function PATCH(request: NextRequest) {
  try {
    const { id, items, ...fields } = await request.json();
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

    const updates = sanitize(fields);
    let purchaseRow: Record<string, any> | null = null;
    if (Object.keys(updates).length > 0) {
      purchaseRow = await updatePurchase(id, updates);
    }
    if (Array.isArray(items)) {
      try {
        await replaceItems(id, items);
      } catch (itemErr: any) {
        if (!/purchase_pool_items/i.test(itemErr?.message || '')) throw itemErr;
      }
    }
    const purchase = await loadPurchase(id);
    return NextResponse.json({ purchase: purchase ?? withDefaultPoolFields(purchaseRow ?? { id }) });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// -----------------------------------------------------------------------
// DELETE /api/purchases?id=<uuid>
// -----------------------------------------------------------------------
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

    const { error } = await supabaseAdmin.from('card_purchases').delete().eq('id', id);
    if (error) throw error;
    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

function stripPoolColumns(row: Record<string, any>) {
  const { allocation_mode, expected_bulk_recovery, ...rest } = row;
  return rest;
}

function isMissingPoolColumn(err: any) {
  return /allocation_mode|expected_bulk_recovery|purchase_pool_items/i.test(err?.message || '');
}

async function insertPurchase(row: Record<string, any>) {
  let { data, error } = await supabaseAdmin.from('card_purchases').insert(row).select().single();
  if (error && isMissingPoolColumn(error)) {
    ({ data, error } = await supabaseAdmin
      .from('card_purchases')
      .insert(stripPoolColumns(row))
      .select()
      .single());
  }
  return { data, error };
}

async function updatePurchase(id: string, updates: Record<string, any>) {
  let { data, error } = await supabaseAdmin
    .from('card_purchases')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  if (error && isMissingPoolColumn(error)) {
    ({ data, error } = await supabaseAdmin
      .from('card_purchases')
      .update(stripPoolColumns(updates))
      .eq('id', id)
      .select()
      .single());
  }
  if (error) throw error;
  return data;
}

function withDefaultPoolFields(row: any) {
  if (!row) return row;
  return {
    ...row,
    allocation_mode: parseAllocationMode(row.allocation_mode),
    expected_bulk_recovery: Number(row.expected_bulk_recovery) || 0,
    items: Array.isArray(row.items) ? row.items : [],
  };
}

async function loadPurchase(id: string) {
  const { data, error } = await supabaseAdmin
    .from('card_purchases')
    .select(ITEM_SELECT)
    .eq('id', id)
    .maybeSingle();
  if (error || !data) return null;
  return withDefaultPoolFields(data);
}

async function replaceItems(purchaseId: string, items: any[]) {
  const incoming = items.map((it, i) => sanitizeItem(it, purchaseId, i)).filter(Boolean) as Record<string, any>[];
  const existing = incoming.filter(it => it.id);
  const created = incoming.filter(it => !it.id);
  const keepIds = existing.map(it => it.id);

  let del = supabaseAdmin.from('purchase_pool_items').delete().eq('purchase_id', purchaseId);
  if (keepIds.length > 0) del = del.not('id', 'in', `(${keepIds.join(',')})`);
  const { error: delErr } = await del;
  if (delErr) throw delErr;

  if (existing.length > 0) {
    const { error } = await supabaseAdmin.from('purchase_pool_items').upsert(existing, { onConflict: 'id' });
    if (error) throw error;
  }
  if (created.length > 0) {
    const { error } = await supabaseAdmin.from('purchase_pool_items').insert(created);
    if (error) throw error;
  }
}

function sanitizeItem(raw: Record<string, any>, purchaseId: string, sortOrder: number) {
  if (!raw) return null;
  const row: Record<string, any> = {
    purchase_id: purchaseId,
    label: raw.label || null,
    estimated_value: parseFloat(raw.estimated_value ?? raw.estimatedValue) || 0,
    allocated_cost:
      raw.allocated_cost == null && raw.allocatedCostOverride == null && raw.allocated_cost_override == null
        ? null
        : parseFloat(raw.allocated_cost ?? raw.allocatedCostOverride ?? raw.allocated_cost_override),
    status: raw.status || 'in_stock',
    qty: parseInt(raw.qty, 10) > 0 ? parseInt(raw.qty, 10) : 1,
    sort_order: raw.sort_order ?? sortOrder,
  };
  if (raw.id && String(raw.id).length > 8) row.id = raw.id;
  if (raw.sale_id !== undefined) row.sale_id = raw.sale_id || null;
  if (row.allocated_cost != null && !Number.isFinite(row.allocated_cost)) row.allocated_cost = null;
  return row;
}

// -----------------------------------------------------------------------
// Sanitize / whitelist fields from the request body.
// -----------------------------------------------------------------------
function sanitize(raw: Record<string, any>) {
  return {
    ...(raw.purchase_date !== undefined && { purchase_date: raw.purchase_date }),
    ...(raw.year !== undefined && { year: raw.year ? parseInt(raw.year) : null }),
    ...(raw.brand !== undefined && { brand: raw.brand || null }),
    ...(raw.series !== undefined && { series: raw.series || null }),
    ...(raw.sport !== undefined && { sport: raw.sport || null }),
    ...(raw.team !== undefined && { team: raw.team || null }),
    ...(raw.box_size !== undefined && { box_size: raw.box_size || null }),
    ...(raw.cost !== undefined && { cost: parseFloat(raw.cost) || 0 }),
    ...(raw.quantity !== undefined && { quantity: parseInt(raw.quantity) || 1 }),
    ...(raw.sku !== undefined && { sku: raw.sku || null }),
    ...(raw.bought_from !== undefined && { bought_from: raw.bought_from || 'eBay' }),
    ...(raw.notes !== undefined && { notes: raw.notes || null }),
    ...(raw.allocation_mode !== undefined && { allocation_mode: parseAllocationMode(raw.allocation_mode) }),
    ...(raw.expected_bulk_recovery !== undefined && {
      expected_bulk_recovery: parseFloat(raw.expected_bulk_recovery) || 0,
    }),
  };
}
