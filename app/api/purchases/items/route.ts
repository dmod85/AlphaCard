import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabase-admin';
import { parsePoolItemStatus } from '@/app/lib/pool-roi';

// POST /api/purchases/items  { purchase_id, label?, estimated_value?, allocated_cost?, status?, qty? }
export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        if (!body.purchase_id) {
            return NextResponse.json({ error: 'purchase_id required' }, { status: 400 });
        }
        const row = sanitize(body);
        const { data, error } = await supabaseAdmin
            .from('purchase_pool_items')
            .insert(row)
            .select()
            .single();
        if (error) throw error;
        return NextResponse.json({ item: data });
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

// PATCH /api/purchases/items  { id, ...fields }
export async function PATCH(request: NextRequest) {
    try {
        const { id, ...fields } = await request.json();
        if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
        const { data, error } = await supabaseAdmin
            .from('purchase_pool_items')
            .update(sanitize(fields))
            .eq('id', id)
            .select()
            .single();
        if (error) throw error;
        return NextResponse.json({ item: data });
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

// DELETE /api/purchases/items?id=<uuid>
export async function DELETE(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const id = searchParams.get('id');
        if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
        const { error } = await supabaseAdmin.from('purchase_pool_items').delete().eq('id', id);
        if (error) throw error;
        return NextResponse.json({ success: true });
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

function sanitize(raw: Record<string, any>) {
    const row: Record<string, any> = {};
    if (raw.purchase_id !== undefined) row.purchase_id = raw.purchase_id;
    if (raw.label !== undefined) row.label = raw.label || null;
    if (raw.estimated_value !== undefined) row.estimated_value = parseFloat(raw.estimated_value) || 0;
    if (raw.allocated_cost !== undefined) {
        row.allocated_cost =
            raw.allocated_cost === null || raw.allocated_cost === ''
                ? null
                : parseFloat(raw.allocated_cost);
    }
    if (raw.status !== undefined) row.status = parsePoolItemStatus(raw.status);
    if (raw.qty !== undefined) row.qty = parseInt(raw.qty, 10) > 0 ? parseInt(raw.qty, 10) : 1;
    if (raw.sale_id !== undefined) row.sale_id = raw.sale_id || null;
    if (raw.sort_order !== undefined) row.sort_order = parseInt(raw.sort_order, 10) || 0;
    return row;
}
