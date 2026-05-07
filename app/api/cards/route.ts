import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabase-admin';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get('q')?.trim();
  const setId = searchParams.get('set_id');

  if (setId) {
    // Fetch all cards in a set + the set's parallel info
    const [cardsRes, setRes] = await Promise.all([
      supabaseAdmin
        .from('cards')
        .select('id, card_number, player_name, team, rarity, set_id')
        .eq('set_id', setId)
        .order('card_number'),
      supabaseAdmin
        .from('card_sets')
        .select('id, name, year, brand, base_parallels')
        .eq('id', setId)
        .single(),
    ]);

    if (cardsRes.error) return NextResponse.json({ error: cardsRes.error.message }, { status: 500 });
    return NextResponse.json({ cards: cardsRes.data, set: setRes.data });
  }

  if (!q || q.length < 2) {
    return NextResponse.json({ cards: [] });
  }

  // Full-text search on player_name, join with set name
  const { data, error } = await supabaseAdmin
    .from('cards')
    .select(`
      id, card_number, player_name, team, rarity, set_id,
      card_sets ( id, name, year, brand, base_parallels )
    `)
    .ilike('player_name', `%${q}%`)
    .order('player_name')
    .limit(30);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ cards: data });
}
