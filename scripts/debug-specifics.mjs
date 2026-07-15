// Diagnostic: check full XML structure
import { readFileSync } from 'fs';

const env = readFileSync('.env.local', 'utf8');
env.split('\n').forEach(line => {
  const [k, ...rest] = line.trim().split('=');
  if (k && rest.length) process.env[k.trim()] = rest.join('=').trim().replace(/\r$/, '');
});

const { createClient } = await import('@supabase/supabase-js');
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const { data: tokenRow } = await supabase.from('ebay_tokens').select('access_token').eq('id', 'default').single();
const token = tokenRow.access_token;

const now = new Date();
const future = new Date();
future.setDate(future.getDate() + 120);

const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetSellerListRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <Pagination><EntriesPerPage>1</EntriesPerPage><PageNumber>1</PageNumber></Pagination>
  <DetailLevel>ItemReturnDescription</DetailLevel>
  <IncludeItemSpecifics>true</IncludeItemSpecifics>
  <EndTimeFrom>${now.toISOString()}</EndTimeFrom>
  <EndTimeTo>${future.toISOString()}</EndTimeTo>
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
</GetSellerListRequest>`;

const res = await fetch('https://api.ebay.com/ws/api.dll', {
  method: 'POST',
  headers: {
    'Content-Type': 'text/xml',
    'X-EBAY-API-COMPATIBILITY-LEVEL': '1349',
    'X-EBAY-API-DEV-NAME': process.env.EBAY_DEV_ID,
    'X-EBAY-API-APP-NAME': process.env.EBAY_APP_ID,
    'X-EBAY-API-CERT-NAME': process.env.EBAY_CERT_ID,
    'X-EBAY-API-CALL-NAME': 'GetSellerList',
    'X-EBAY-API-SITEID': '0',
    'X-EBAY-API-IAF-TOKEN': token,
  },
  body: xml,
});

const text = await res.text();
console.log('Total XML length:', text.length);

// Count all Item tags
const openTags = (text.match(/<Item>/g) || []).length;
const closeTags = (text.match(/<\/Item>/g) || []).length;
console.log('<Item> open tags:', openTags, '  </Item> close tags:', closeTags);

// Count NameValueList
const nvCount = (text.match(/<NameValueList>/g) || []).length;
console.log('<NameValueList> count in full XML:', nvCount);

// Count ItemSpecifics
const isCount = (text.match(/<ItemSpecifics>/g) || []).length;
console.log('<ItemSpecifics> count in full XML:', isCount);

// Find where ItemSpecifics appears relative to Item
const itemArrayMatch = text.match(/<ItemArray>([\s\S]*?)<\/ItemArray>/);
if (itemArrayMatch) {
  const arr = itemArrayMatch[1];
  console.log('\nItemArray length:', arr.length);
  
  // Try greedy match for the single item in here
  const itemGreedy = arr.match(/<Item>([\s\S]*)<\/Item>/);
  if (itemGreedy) {
    console.log('Item (greedy) length:', itemGreedy[1].length);
    const nvInGreedy = (itemGreedy[1].match(/<NameValueList>/g) || []).length;
    console.log('NameValueList in greedy item:', nvInGreedy);
    
    // Print the ItemSpecifics section
    const isMatch = itemGreedy[1].match(/<ItemSpecifics>([\s\S]*?)<\/ItemSpecifics>/);
    if (isMatch) {
      console.log('\nItemSpecifics section:');
      console.log(isMatch[1].substring(0, 1000));
    }
  }
  
  // Show item tag positions
  let pos = 0;
  const positions = [];
  while ((pos = arr.indexOf('<Item>', pos)) !== -1) {
    positions.push(pos);
    pos++;
  }
  const endPositions = [];
  pos = 0;
  while ((pos = arr.indexOf('</Item>', pos)) !== -1) {
    endPositions.push(pos);
    pos++;
  }
  console.log('\n<Item> positions:', positions.slice(0, 5));
  console.log('</Item> positions:', endPositions.slice(0, 5));
  
  // What's at end of non-greedy match?
  const itemNonGreedy = arr.match(/<Item>([\s\S]*?)<\/Item>/);
  if (itemNonGreedy) {
    console.log('\nNon-greedy item length:', itemNonGreedy[1].length);
    console.log('Last 500 chars of non-greedy item:');
    console.log(itemNonGreedy[1].slice(-500));
  }
}
