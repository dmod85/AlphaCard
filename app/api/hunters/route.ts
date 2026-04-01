import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabase';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const limit = parseInt(searchParams.get('limit') || '20');
  const hunterType = searchParams.get('type');

  let query = supabaseAdmin
    .from('hunter_runs')
    .select('*')
    .order('started_at', { ascending: false })
    .limit(limit);

  if (hunterType) query = query.eq('hunter_type', hunterType);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ runs: data });
}
