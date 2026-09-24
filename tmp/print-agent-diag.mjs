import fs from 'fs';
import path from 'path';

function loadEnvLocal() {
    const envPath = path.join('C:\\server\\AlphaCard', '.env.local');
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m && !process.env[m[1]]) {
            process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
        }
    }
}
loadEnvLocal();

const { createClient } = await import('@supabase/supabase-js');
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

const since = new Date(Date.now() - 1000 * 60 * 60 * 24 * 45).toISOString();

const pending = await supabase
    .from('ebay_sales')
    .select('order_number, packing_slip_url, printed_at, shipped_at, tracking_number, packing_slip_generated_at')
    .not('packing_slip_url', 'is', null)
    .is('printed_at', null)
    .limit(20);

const recent = await supabase
    .from('ebay_sales')
    .select('order_number, sale_date, shipped_at, tracking_number, packing_slip_url, printed_at, packing_slip_generated_at')
    .gte('sale_date', since)
    .order('sale_date', { ascending: false })
    .limit(30);

const events = await supabase
    .from('ebay_webhook_events')
    .select('notification_id, topic, order_number, received_at')
    .order('received_at', { ascending: false })
    .limit(15);

function brief(rows) {
    return (rows ?? []).map((r) => ({
        order: r.order_number,
        sale: r.sale_date ?? null,
        shipped: r.shipped_at ?? null,
        tracking: r.tracking_number ? 'yes' : 'no',
        slip: r.packing_slip_url ? 'yes' : 'no',
        printed: r.printed_at ?? null,
        generated: r.packing_slip_generated_at ?? null,
        received: r.received_at ?? null,
        topic: r.topic ?? null,
    }));
}

console.log(JSON.stringify({
    pendingError: pending.error?.message ?? null,
    pendingCount: pending.data?.length ?? 0,
    pending: brief(pending.data),
    recentError: recent.error?.message ?? null,
    recent: brief(recent.data),
    eventsError: events.error?.message ?? null,
    events: brief(events.data),
}, null, 2));

const channel = supabase
    .channel('print-agent-diag')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'ebay_sales' }, () => { })
    .subscribe((status, err) => {
        console.log('REALTIME', status, err ? JSON.stringify(err) : '');
    });

setTimeout(async () => {
    await supabase.removeChannel(channel);
    process.exit(0);
}, 12000);
