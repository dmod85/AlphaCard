import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function main() {
  const { data, error } = await supabase.from('ebay_tokens').select('*');
  console.log('All tokens:', data, error);
}

main();
