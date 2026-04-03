import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabase';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const { id } = params;

  // Fetch the lead to get player_name, card_set, card_year 
  const { data: lead, error: leadError } = await supabaseAdmin
    .from('raw_leads')
    .select('player_name, card_set, card_year, parallel_type')
    .eq('id', id)
    .single();

  if (leadError || !lead) {
    return NextResponse.json({ error: 'Lead not found' }, { status: 404 });
  }

  if (!lead.player_name) {
    return NextResponse.json({ comps: [] });
  }

  // Fetch all comps (including outliers) so the UI can show what was kept vs removed
  const cutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();

  let query = supabaseAdmin
    .from('sold_comps')
    .select('id, ebay_item_id, title, sold_price, sold_date, item_url, image_url, is_outlier, outlier_reason')
    .ilike('player_name', `%${lead.player_name}%`)
    .gte('sold_date', cutoff)
    .order('sold_date', { ascending: false })
    .limit(50);

  if (lead.card_set) query = query.ilike('card_set', `%${lead.card_set}%`);
  if (lead.card_year) query = query.eq('card_year', lead.card_year);

  const { data: comps, error: compsError } = await query;

  if (compsError) {
    return NextResponse.json({ error: compsError.message }, { status: 500 });
  }

  const sorted = (comps || []).sort((a, b) => {
    // Non-outliers first, then by date desc
    if (a.is_outlier !== b.is_outlier) return a.is_outlier ? 1 : -1;
    return new Date(b.sold_date).getTime() - new Date(a.sold_date).getTime();
  });

  return NextResponse.json({ comps: sorted });
}
