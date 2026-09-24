import fs from 'fs';
import { execFile } from 'child_process';
import { createClient } from '@supabase/supabase-js';

const pdf = process.argv[2];
for (const line of fs.readFileSync('C:\\server\\AlphaCard\\.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
}
const text = await new Promise((resolve) => {
    execFile('python', ['-c', 'import sys,pypdfium2 as p; print(p.PdfDocument(sys.argv[1])[0].get_textpage().get_text_bounded() or "")', pdf], (err, stdout) => {
        resolve(err ? '' : stdout);
    });
});
const compact = `${pdf}\n${text}`.replace(/\s+/g, '');
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
const { data, error } = await supabase
    .from('ebay_sales')
    .select('order_number, tracking_number, sale_date, printed_at, ship_to_name, buyer')
    .order('sale_date', { ascending: false })
    .limit(40);
if (error) {
    console.log('query', error.message);
    process.exit(1);
}
const hits = [];
for (const row of data ?? []) {
    const tracking = String(row.tracking_number || '').replace(/\s+/g, '');
    const orderNumber = String(row.order_number || '').replace(/\s+/g, '');
    if ((tracking && compact.includes(tracking)) || (orderNumber && compact.includes(orderNumber))) {
        hits.push(`${row.order_number} tracking=${tracking ? 'yes' : 'no'} printed=${row.printed_at ? 'yes' : 'no'}`);
    }
}
console.log(hits.length ? hits.join('\n') : 'no match');
console.log('newest', data?.[0]?.order_number, data?.[0]?.sale_date, 'tracking', data?.[0]?.tracking_number ? 'yes' : 'no');
const digits = compact.replace(/\D/g, '');
let digitHit = null;
for (const row of data ?? []) {
    const t = String(row.tracking_number || '').replace(/\D/g, '');
    if (t.length >= 8 && digits.includes(t)) digitHit = row.order_number;
}
console.log('digitHit', digitHit);
const nameHits = [];
for (const row of data ?? []) {
    const name = String(row.ship_to_name || row.buyer || '').toUpperCase().replace(/[^A-Z]/g, '');
    if (name.length >= 6 && compact.toUpperCase().includes(name)) nameHits.push(row.order_number);
}
console.log('nameHits', nameHits.join(',') || 'none');
