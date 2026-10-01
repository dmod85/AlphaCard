import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function main() {
  const { data: purchases, error: pError } = await supabase
    .from('card_purchases')
    .select('*')
    .eq('sku', 'Sophie_Lot');
    
  if (pError) console.error('Error fetching purchases:', pError);

  const totalPurchaseCost = purchases?.reduce((sum, p) => sum + Number(p.cost), 0);
  console.log('Total Purchase Cost:', totalPurchaseCost);

  const { data: sales, error: sError } = await supabase
    .from('ebay_sales')
    .select('*')
    .eq('sku', 'Sophie_Lot');

  if (sError) console.error('Error fetching sales:', sError);
  
  const totalSales = sales?.reduce((sum, s) => sum + Number(s.sold_for || 0), 0);
  console.log('Total Sales (sold_for):', totalSales);

  // Compute price band pool
  const { computePriceBandPool } = await import('./app/lib/price-bands.js');
  const bandSales = sales?.map(s => ({
      quantitySold: s.quantity_sold || 1,
      soldFor: s.sold_for || 0,
      net: s.net_profit || 0
  })) || [];
  
  const pool = computePriceBandPool(totalPurchaseCost, bandSales);
  console.log('\nPrice Band Pool:');
  console.log(JSON.stringify(pool, null, 2));
}

main();
