const token = 'v^1.1#i^1#p^3#f^0#I^3#r^0#t^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';

async function main() {
  try {
    const requestXml = `<?xml version="1.0" encoding="utf-8"?>
<GetOrdersRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${token}</eBayAuthToken>
  </RequesterCredentials>
  <OrderRole>Buyer</OrderRole>
  <OrderStatus>Completed</OrderStatus>
  <NumberOfDays>30</NumberOfDays>
  <DetailLevel>ReturnAll</DetailLevel>
</GetOrdersRequest>`;

    const headers = {
      'Content-Type': 'text/xml',
      'X-EBAY-API-COMPATIBILITY-LEVEL': '1349',
      'X-EBAY-API-DEV-NAME': process.env.EBAY_DEV_ID,
      'X-EBAY-API-APP-NAME': process.env.EBAY_APP_ID,
      'X-EBAY-API-CERT-NAME': process.env.EBAY_CERT_ID,
      'X-EBAY-API-CALL-NAME': 'GetOrders',
      'X-EBAY-API-SITEID': '0',
      'X-EBAY-API-IAF-TOKEN': token
    };

    const url = 'https://api.ebay.com/ws/api.dll';

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
