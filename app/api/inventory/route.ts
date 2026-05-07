import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabase-admin';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const status = searchParams.get('status');

  let query = supabaseAdmin.from('inventory').select('*').order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ cards: data });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { data, error } = await supabaseAdmin.from('inventory').insert(body).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ card: data });
}

export async function PATCH(request: NextRequest) {
  const body = await request.json();
  const { id, ...updates } = body;
  if (!id) return NextResponse.json({ error: 'Card ID required' }, { status: 400 });

  // Auto-calculate profit on sale
  if (updates.status === 'sold' && updates.sold_price) {
    const { data: card } = await supabaseAdmin
      .from('inventory')
      .select('total_cost, grading_cost')
      .eq('id', id)
      .single();

    if (card) {
      const totalCost = parseFloat(card.total_cost || '0') + parseFloat(card.grading_cost || '0');
      const fees = updates.ebay_fees_paid || updates.sold_price * 0.1325 + 0.30;
      const shipping = updates.shipping_cost || 0.63;
      updates.net_profit = Math.round((updates.sold_price - totalCost - fees - shipping) * 100) / 100;
      updates.roi_pct = totalCost > 0 ? Math.round((updates.net_profit / totalCost) * 10000) / 100 : 0;
      updates.sold_date = new Date().toISOString();
    }
  }

  const { data, error } = await supabaseAdmin.from('inventory').update(updates).eq('id', id).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ card: data });
}
