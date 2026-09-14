import 'server-only';
import { supabaseAdmin } from '@/app/lib/supabase-admin';
import { looksLikeEstimatedAdFee } from '@/app/lib/pnl';

const CHUNK = 50;

/** Drop baked-in 16% ad estimates so ROI only counts Finances-reported ads. */
export async function clearEstimatedAdFees(): Promise<{ cleared: number }> {
    try {
        const { data: settings } = await supabaseAdmin
            .from('pnl_settings')
            .select('default_ad_rate')
            .eq('id', 1)
            .maybeSingle();
        if (settings && Number(settings.default_ad_rate) !== 0) {
            await supabaseAdmin
                .from('pnl_settings')
                .update({ default_ad_rate: 0, updated_at: new Date().toISOString() })
                .eq('id', 1);
        }
    } catch (err: any) {
        console.error('[clear-estimated-ads] settings:', err?.message || err);
    }

    const { data, error } = await supabaseAdmin
        .from('ebay_sales')
        .select('id, sold_for, order_shipping_cost, advertising_fee')
        .not('advertising_fee', 'is', null)
        .range(0, 9999);
    if (error) {
        console.error('[clear-estimated-ads] load:', error.message);
        return { cleared: 0 };
    }

    const ids = (data ?? [])
        .filter((s) =>
            looksLikeEstimatedAdFee(
                Number(s.sold_for || 0),
                s.advertising_fee == null ? null : Number(s.advertising_fee),
                Number(s.order_shipping_cost || 0)
            )
        )
        .map((s) => s.id);

    let cleared = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);
        const { error: upErr } = await supabaseAdmin
            .from('ebay_sales')
            .update({ advertising_fee: null })
            .in('id', chunk);
        if (upErr) {
            console.error('[clear-estimated-ads] update:', upErr.message);
            continue;
        }
        cleared += chunk.length;
    }
    return { cleared };
}
