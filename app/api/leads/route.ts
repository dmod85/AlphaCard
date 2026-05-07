import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabase-admin';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const status = searchParams.get('status') || 'new';
  const sport = searchParams.get('sport');
  const hunter = searchParams.get('hunter');
  const sort = searchParams.get('sort') || 'confidence';
  const limit = parseInt(searchParams.get('limit') || '50');
  const offset = parseInt(searchParams.get('offset') || '0');
  const discoveredAfter = searchParams.get('discovered_after');

  let query = supabaseAdmin
    .from('raw_leads')
    .select('*', { count: 'exact' })
    .eq('status', status)
    .order(sort, { ascending: false })
    .range(offset, offset + limit - 1);

  if (sport) query = query.eq('sport', sport);
  if (hunter) query = query.eq('hunter_source', hunter);
  if (discoveredAfter) query = query.gte('discovered_at', discoveredAfter);

  const { data, error, count } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ leads: data, total: count });
}

export async function PATCH(request: NextRequest) {
  const body = await request.json();
  const { id, ...updates } = body;

  if (!id) {
    return NextResponse.json({ error: 'Lead ID required' }, { status: 400 });
  }

  if (updates.status === 'dismissed' || updates.status === 'purchased') {
    updates.reviewed_at = new Date().toISOString();
  }

  const { data, error } = await supabaseAdmin
    .from('raw_leads')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ lead: data });
}
