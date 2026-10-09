import { getValidToken, getEbayApiHeaders, getEbayApiUrl } from '../app/lib/ebay-auth';

async function main() {
  try {
    const token = await getValidToken();
    const url = getEbayApiUrl();

    // We can use GetMyeBayBuying to get recent purchases
    const requestXml = `<?xml version="1.0" encoding="utf-8"?>
<GetOrdersRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${token}</eBayAuthToken>
  </RequesterCredentials>
  <OrderRole>Buyer</OrderRole>
  <OrderStatus>Completed</OrderStatus>
  <NumberOfDays>120</NumberOfDays>
</GetOrdersRequest>`;

    const headers = getEbayApiHeaders('GetOrders', token);

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
