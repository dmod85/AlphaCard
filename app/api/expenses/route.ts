import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabase-admin';
import { EXPENSE_CATEGORIES, type ExpenseCategory } from '@/app/lib/pnl';

function isCategory(v: unknown): v is ExpenseCategory {
    return typeof v === 'string' && (EXPENSE_CATEGORIES as readonly string[]).includes(v);
}

function sanitize(raw: Record<string, any>) {
    const out: Record<string, unknown> = {};
    if (raw.expense_date !== undefined) out.expense_date = raw.expense_date || null;
    if (raw.category !== undefined) {
        if (!isCategory(raw.category)) throw new Error('Invalid category');
        out.category = raw.category;
    }
    if (raw.amount !== undefined) out.amount = parseFloat(raw.amount) || 0;
    if (raw.notes !== undefined) out.notes = raw.notes || null;
    return out;
}

export async function GET() {
    try {
        const { data, error } = await supabaseAdmin
            .from('operating_expenses')
            .select('*')
            .order('expense_date', { ascending: false })
            .order('created_at', { ascending: false });
        if (error) throw error;
        return NextResponse.json({ expenses: data ?? [] });
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const row = sanitize({
            expense_date: body.expense_date || new Date().toISOString().slice(0, 10),
            category: body.category,
            amount: body.amount,
            notes: body.notes,
        });
        if (!row.category) return NextResponse.json({ error: 'category required' }, { status: 400 });

        const { data, error } = await supabaseAdmin
            .from('operating_expenses')
            .insert(row)
            .select()
            .single();
        if (error) throw error;
        return NextResponse.json({ expense: data });
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

export async function PATCH(request: NextRequest) {
    try {
        const { id, ...fields } = await request.json();
        if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

        const { data, error } = await supabaseAdmin
            .from('operating_expenses')
            .update(sanitize(fields))
            .eq('id', id)
            .select()
            .single();
        if (error) throw error;
        return NextResponse.json({ expense: data });
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

export async function DELETE(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const id = searchParams.get('id');
        if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

        const { error } = await supabaseAdmin.from('operating_expenses').delete().eq('id', id);
        if (error) throw error;
        return NextResponse.json({ success: true });
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
