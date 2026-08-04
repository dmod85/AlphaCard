import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabase-admin';

export async function GET() {
  const { data, error } = await supabaseAdmin
    .from('search_queries')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ queries: data });
}

export async function POST(request: NextRequest) {
  const body = await request.json();

  if (!body.query || body.max_price == null) {
    return NextResponse.json(
      { error: 'query and max_price are required' },
      { status: 400 }
    );
  }

  const row = {
    query: body.query,
    max_price: body.max_price,
    active: body.active !== false,
  };

  const { data, error } = await supabaseAdmin
    .from('search_queries')
    .insert(row)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ query: data }, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const body = await request.json();
  const { id, ...updates } = body;

  if (!id) return NextResponse.json({ error: 'Query ID required' }, { status: 400 });

  const { data, error } = await supabaseAdmin
    .from('search_queries')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ query: data });
}

export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) return NextResponse.json({ error: 'Query ID required' }, { status: 400 });

  const { error } = await supabaseAdmin
    .from('search_queries')
    .delete()
    .eq('id', id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ deleted: true });
}
