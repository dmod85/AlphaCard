import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabase-admin';

// -----------------------------------------------------------------------
// GET /api/purchases
// Returns all purchase rows, grouped by sku on the client.
// Optional query params:
//   ?q=<search>     — filters by sku, brand, series, sport (ilike)
//   ?sku=<sku>      — filter to a specific sku
// -----------------------------------------------------------------------
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const q = searchParams.get('q')?.trim();
    const skuFilter = searchParams.get('sku')?.trim();

    let query = supabaseAdmin
      .from('card_purchases')
      .select('*')
      .order('purchase_date', { ascending: false })
      .order('created_at', { ascending: false });

    if (skuFilter) {
      query = query.eq('sku', skuFilter);
    } else if (q) {
      query = query.or(
        `sku.ilike.%${q}%,brand.ilike.%${q}%,series.ilike.%${q}%,sport.ilike.%${q}%,bought_from.ilike.%${q}%`
      );
    }

    const { data, error } = await query;
    if (error) {
      console.error('[purchases GET] Supabase error:', error.code, error.message);
      throw error;
    }

    return NextResponse.json({ purchases: data ?? [] });
  } catch (err: any) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 500 });
  }
}

// -----------------------------------------------------------------------
// POST /api/purchases
// Create one or more purchase rows.
// Body: single purchase object OR { rows: [...] } for CSV bulk import.
// -----------------------------------------------------------------------
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // Bulk import path: { rows: [...] }
    if (body.rows && Array.isArray(body.rows)) {
      const rows = body.rows.map(sanitize);
      const { data, error } = await supabaseAdmin
        .from('card_purchases')
        .insert(rows)
        .select();
      if (error) throw error;
      return NextResponse.json({ purchases: data });
    }

    // Single row
    const row = sanitize(body);
    const { data, error } = await supabaseAdmin
      .from('card_purchases')
      .insert(row)
      .select()
      .single();
    if (error) throw error;
    return NextResponse.json({ purchase: data });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// -----------------------------------------------------------------------
// PATCH /api/purchases
// Update an existing purchase row by id.
// Body: { id, ...fields }
// -----------------------------------------------------------------------
export async function PATCH(request: NextRequest) {
  try {
    const { id, ...fields } = await request.json();
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

    const { data, error } = await supabaseAdmin
      .from('card_purchases')
      .update(sanitize(fields))
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return NextResponse.json({ purchase: data });
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
  };
}
