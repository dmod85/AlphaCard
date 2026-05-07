import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabase-admin';

export async function GET() {
  const { data, error } = await supabaseAdmin
    .from('player_watchlist')
    .select('*')
    .order('priority', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ players: data });
}

export async function POST(request: NextRequest) {
  const body = await request.json();

  // Validate required fields
  if (!body.player_name || !body.sport) {
    return NextResponse.json(
      { error: 'player_name and sport are required' },
      { status: 400 }
    );
  }

  // Ensure arrays are properly formatted
  const player = {
    player_name: body.player_name,
    sport: body.sport,
    team: body.team || null,
    priority: body.priority || 5,
    aliases: body.aliases || [],
    common_typos: body.common_typos || [],
    target_sets: body.target_sets || [],
    target_years: body.target_years || [],
    min_value: body.min_value || 5.0,
    max_buy_price: body.max_buy_price || null,
    active: body.active !== false,
  };

  const { data, error } = await supabaseAdmin
    .from('player_watchlist')
    .insert(player)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ player: data }, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const body = await request.json();
  const { id, ...updates } = body;

  if (!id) return NextResponse.json({ error: 'Player ID required' }, { status: 400 });

  const { data, error } = await supabaseAdmin
    .from('player_watchlist')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ player: data });
}

export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) return NextResponse.json({ error: 'Player ID required' }, { status: 400 });

  const { error } = await supabaseAdmin
    .from('player_watchlist')
    .delete()
    .eq('id', id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ deleted: true });
}
