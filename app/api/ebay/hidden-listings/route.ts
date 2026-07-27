import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabase-admin';

/**
 * GET /api/ebay/hidden-listings?itemIds=1,2,3
 * Returns the subset of the given item IDs that are hidden — i.e. excluded
 * from the Listing Details page and all its checks (Title/Description/Duplicate).
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const itemIds = (searchParams.get('itemIds') || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (itemIds.length === 0) {
      return NextResponse.json({ hiddenIds: [] });
    }

    const { data, error } = await supabaseAdmin
      .from('ebay_hidden_listings')
      .select('item_id')
      .in('item_id', itemIds);

    if (error) throw error;

    return NextResponse.json({ hiddenIds: (data ?? []).map((r) => r.item_id as string) });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to fetch hidden listings' }, { status: 500 });
  }
}

/**
 * POST /api/ebay/hidden-listings
 * Body: { itemId, hidden }
 * Hides or unhides a listing from the Listing Details page and its checks.
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { itemId?: string; hidden?: boolean };
    const itemId = body.itemId?.trim();
    if (!itemId) {
      return NextResponse.json({ error: 'itemId is required' }, { status: 400 });
    }

    if (body.hidden) {
      const { error } = await supabaseAdmin
        .from('ebay_hidden_listings')
        .upsert({ item_id: itemId }, { onConflict: 'item_id' });
      if (error) throw error;
    } else {
      const { error } = await supabaseAdmin.from('ebay_hidden_listings').delete().eq('item_id', itemId);
      if (error) throw error;
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to update hidden listing' }, { status: 500 });
  }
}
