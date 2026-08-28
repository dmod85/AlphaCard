import { supabaseAdmin } from '@/app/lib/supabase-admin';

/** Sidecar keys in ebay_hidden_listings until exclude_from_stats is migrated. */
export const SALE_EXCLUDE_PREFIX = 'sale:';

function sidecarId(saleId: string): string {
    return `${SALE_EXCLUDE_PREFIX}${saleId}`;
}

export async function loadExcludedSaleIds(): Promise<Set<string>> {
    const { data, error } = await supabaseAdmin
        .from('ebay_hidden_listings')
        .select('item_id')
        .like('item_id', `${SALE_EXCLUDE_PREFIX}%`);
    if (error) {
        console.error('[sale-exclusions] load:', error.message);
        return new Set();
    }
    const ids = new Set<string>();
    for (const row of data ?? []) {
        const raw = String(row.item_id || '');
        if (raw.startsWith(SALE_EXCLUDE_PREFIX)) ids.add(raw.slice(SALE_EXCLUDE_PREFIX.length));
    }
    return ids;
}

export async function setSalesExcluded(ids: string[], excluded: boolean): Promise<void> {
    const unique = Array.from(new Set(ids.filter(Boolean)));
    if (unique.length === 0) return;

    const { error: colErr } = await supabaseAdmin
        .from('ebay_sales')
        .update({ exclude_from_stats: excluded })
        .in('id', unique);
    if (colErr && colErr.code !== '42703' && !/exclude_from_stats/i.test(colErr.message || '')) {
        throw colErr;
    }

    if (excluded) {
        const { error } = await supabaseAdmin
            .from('ebay_hidden_listings')
            .upsert(
                unique.map((id) => ({ item_id: sidecarId(id) })),
                { onConflict: 'item_id' }
            );
        if (error) throw error;
    } else {
        const { error } = await supabaseAdmin
            .from('ebay_hidden_listings')
            .delete()
            .in('item_id', unique.map(sidecarId));
        if (error) throw error;
    }
}

export async function withExclusionFlags<T extends { id: string; exclude_from_stats?: boolean | null }>(
    sales: T[]
): Promise<Array<T & { exclude_from_stats: boolean }>> {
    if (sales.length === 0) return [];
    const extra = await loadExcludedSaleIds();
    return sales.map((s) => ({
        ...s,
        exclude_from_stats: !!s.exclude_from_stats || extra.has(s.id),
    }));
}
