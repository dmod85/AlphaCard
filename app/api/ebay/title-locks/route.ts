import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabase-admin';

/**
 * GET /api/ebay/title-locks?itemIds=1,2,3
 * Returns the subset of the given item IDs whose title is locked — i.e.
 * manually overridden and excluded from the Listing Details "Title Check"
 * panel's auto-template matching.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const itemIds = (searchParams.get('itemIds') || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (itemIds.length === 0) {
      return NextResponse.json({ lockedIds: [] });
    }

    const { data, error } = await supabaseAdmin
      .from('ebay_title_locks')
      .select('item_id')
      .in('item_id', itemIds);

    if (error) throw error;

    return NextResponse.json({ lockedIds: (data ?? []).map((r) => r.item_id as string) });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to fetch title locks' }, { status: 500 });
  }
}

/**
 * POST /api/ebay/title-locks
 * Body: { itemId, locked }
 * Locks or unlocks a listing's title against the Title Check auto-template.
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { itemId?: string; locked?: boolean };
    const itemId = body.itemId?.trim();
    if (!itemId) {
      return NextResponse.json({ error: 'itemId is required' }, { status: 400 });
    }

    if (body.locked) {
      const { error } = await supabaseAdmin
        .from('ebay_title_locks')
        .upsert({ item_id: itemId }, { onConflict: 'item_id' });
      if (error) throw error;
    } else {
      const { error } = await supabaseAdmin.from('ebay_title_locks').delete().eq('item_id', itemId);
      if (error) throw error;
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to update title lock' }, { status: 500 });
  }
}
