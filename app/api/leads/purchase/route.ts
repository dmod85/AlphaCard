import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabase-admin';

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { lead_id, actual_price, shipping_paid } = body;

  if (!lead_id) {
    return NextResponse.json({ error: 'lead_id is required' }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin.rpc('purchase_lead', {
    lead_id,
    actual_price: actual_price || null,
    shipping_paid: shipping_paid || 0,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    inventory_card_id: data,
    message: 'Lead purchased and added to inventory',
  });
}
