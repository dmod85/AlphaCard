import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function main() {
  try {
    const { data } = await supabase.from('ebay_tokens').select('access_token').eq('id', 'default').single();
    if (!data) throw new Error("No token found");

    const token = data.access_token;
    
    // Trading API getOrders
    const requestXml = `<?xml version="1.0" encoding="utf-8"?>
<GetOrdersRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${token}</eBayAuthToken>
  </RequesterCredentials>
  <OrderRole>Buyer</OrderRole>
  <OrderStatus>Completed</OrderStatus>
  <NumberOfDays>120</NumberOfDays>
</GetOrdersRequest>`;

    const devId = process.env.EBAY_DEV_ID;
    const appId = process.env.EBAY_APP_ID;
    const certId = process.env.EBAY_CERT_ID;

    const headers = {
      'Content-Type': 'text/xml',
      'X-EBAY-API-COMPATIBILITY-LEVEL': '1349',
      'X-EBAY-API-DEV-NAME': devId,
      'X-EBAY-API-APP-NAME': appId,
      'X-EBAY-API-CERT-NAME': certId,
      'X-EBAY-API-CALL-NAME': 'GetOrders',
      'X-EBAY-API-SITEID': '0',
    };
    if (token.startsWith('v^')) {
        headers['X-EBAY-API-IAF-TOKEN'] = token;
    }

    const url = process.env.EBAY_ENVIRONMENT === 'PRODUCTION'
      ? 'https://api.ebay.com/ws/api.dll'
      : 'https://api.sandbox.ebay.com/ws/api.dll';

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: requestXml,
    });

    const text = await res.text();
    console.log(text);

  } catch (err) {
    console.error(err);
  }
}

main();
