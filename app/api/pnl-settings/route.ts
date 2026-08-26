import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabase-admin';
import {
    DEFAULT_PNL_SETTINGS,
    estimateAdFee,
    estimateEbayFee,
    type PnlSettings,
} from '@/app/lib/pnl';

async function loadSettings(): Promise<PnlSettings> {
    const { data, error } = await supabaseAdmin
        .from('pnl_settings')
        .select('*')
        .eq('id', 1)
        .maybeSingle();
    if (error) throw error;
    if (!data) return DEFAULT_PNL_SETTINGS;
    return {
        id: 1,
        default_shipping_cost: Number(data.default_shipping_cost),
        default_supplies_cost: Number(data.default_supplies_cost),
        default_fee_rate: Number(data.default_fee_rate),
        default_processing_fee: Number(data.default_processing_fee),
        default_ad_rate: Number(data.default_ad_rate),
    };
}

export async function GET() {
    try {
        const settings = await loadSettings();
        return NextResponse.json({ settings });
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

export async function PATCH(request: NextRequest) {
    try {
        const body = await request.json();
        const updates: Record<string, number> = {};
        const keys: (keyof Omit<PnlSettings, 'id'>)[] = [
            'default_shipping_cost',
            'default_supplies_cost',
            'default_fee_rate',
            'default_processing_fee',
            'default_ad_rate',
        ];
        for (const k of keys) {
            if (body[k] !== undefined) updates[k] = parseFloat(body[k]) || 0;
        }

        if (Object.keys(updates).length > 0) {
            const { error } = await supabaseAdmin
                .from('pnl_settings')
                .upsert({ id: 1, ...updates, updated_at: new Date().toISOString() }, { onConflict: 'id' });
            if (error) throw error;
        }

        const settings = await loadSettings();

        let filled = 0;
        if (body.apply_to_blank) {
            const { data: sales, error } = await supabaseAdmin
                .from('ebay_sales')
                .select('id, sold_for, ebay_fee, advertising_fee, shipping_cost, supplies_cost');
            if (error) throw error;

            for (const s of sales ?? []) {
                const patch: Record<string, number> = {};
                if (s.ebay_fee == null) patch.ebay_fee = estimateEbayFee(Number(s.sold_for || 0), settings);
                if (s.advertising_fee == null) patch.advertising_fee = estimateAdFee(Number(s.sold_for || 0), settings);
                if (s.shipping_cost == null) patch.shipping_cost = settings.default_shipping_cost;
                if (s.supplies_cost == null) patch.supplies_cost = settings.default_supplies_cost;
                if (Object.keys(patch).length === 0) continue;
                const { error: upErr } = await supabaseAdmin.from('ebay_sales').update(patch).eq('id', s.id);
                if (!upErr) filled += 1;
            }
        }

        return NextResponse.json({ settings, filled });
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
