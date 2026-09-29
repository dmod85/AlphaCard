import {createClient} from '@supabase/supabase-js';
import fs from 'fs';
const env = fs.readFileSync('.env.local', 'utf8').split('\n').reduce((acc, line) => {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) acc[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
    return acc;
}, {});
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
const { data, error } = await supabase.from('ebay_sales').select('order_number, printed_at, sale_date').eq('order_number', '03-15241-39451');
console.log(data, error);
