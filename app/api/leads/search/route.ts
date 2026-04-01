import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabase';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q') || '';
  const status = searchParams.get('status') || 'new';
  const sport = searchParams.get('sport') || null;
  const hunter = searchParams.get('hunter') || null;
  const minProfit = searchParams.get('min_profit') ? parseFloat(searchParams.get('min_profit')!) : null;
  const limit = parseInt(searchParams.get('limit') || '50');
  const offset = parseInt(searchParams.get('offset') || '0');

  const { data, error } = await supabaseAdmin.rpc('search_leads', {
    search_query: query,
    status_filter: status,
    sport_filter: sport,
    hunter_filter: hunter,
    min_profit: minProfit,
    limit_count: limit,
    offset_count: offset,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ leads: data || [], query });
}
