import {
  getValidToken,
  isOAuthToken,
  getEbayApiHeaders,
  getEbayApiUrl,
  clearTokenCache,
} from '@/app/lib/ebay-auth';
import { supabaseAdmin } from '@/app/lib/supabase-admin';
import { getAppAccessToken, ebayApiRoot } from '@/app/lib/ebay-app-token';

// -----------------------------------------------------------------------
// Shared eBay Trading API (GetOrders / GetOrder) parsing + sync helpers.
// Used by both the periodic sold-orders sync and the item-shipped webhook
// (which fetches a single order on demand when it hasn't been synced yet).
// -----------------------------------------------------------------------

const EBAY_AUTH_ERROR_CODES = ['21917053', '21916984', '21917055'];

export function isEbayAuthError(xml: string): boolean {
  return EBAY_AUTH_ERROR_CODES.some((c) => xml.includes(`<ErrorCode>${c}</ErrorCode>`))
    || /validation of the authentication token/i.test(xml);
}

export function decodeXml(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

export interface SaleRow {
  order_number: string;
  item_title: string;
  sku: string | null;
  sold_for: number;
  sale_date: string | null;
  ebay_item_id: string | null;
  buyer: string | null;
  quantity_sold: number;
  picture_url: string | null;
  ship_to_name: string | null;
  ship_to_street1: string | null;
  ship_to_street2: string | null;
  ship_to_city: string | null;
  ship_to_state: string | null;
  ship_to_zip: string | null;
  ship_to_country: string | null;
  ship_to_phone: string | null;
  sales_record_number: string | null;
  shipping_service: string | null;
  order_subtotal: number | null;
  order_shipping_cost: number | null;
  order_tax: number | null;
  order_total: number | null;
  tracking_number: string | null;
  carrier: string | null;
  shipped_at: string | null;
}

/** Parses a numeric XML field, returning null (not 0) when absent so we don't overwrite unknowns. */
export function parseNumOrNull(str: string, tag: string): number | null {
  const m = str.match(new RegExp(`<${tag}[^>]*>(.*?)<\\/${tag}>`));
  return m ? parseFloat(m[1]) : null;
}

export function buildGetOrdersRequest(
  fromDate: string,
  toDate: string,
  page: number,
  token: string
): string {
  const credentials = isOAuthToken(token)
    ? ''
    : `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>`;

  return `<?xml version="1.0" encoding="utf-8"?>
<GetOrdersRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  ${credentials}
  <CreateTimeFrom>${fromDate}</CreateTimeFrom>
  <CreateTimeTo>${toDate}</CreateTimeTo>
  <OrderStatus>Completed</OrderStatus>
  <DetailLevel>ReturnAll</DetailLevel>
  <Pagination>
    <EntriesPerPage>100</EntriesPerPage>
    <PageNumber>${page}</PageNumber>
  </Pagination>
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
</GetOrdersRequest>`;
}

/** Fetches a single order by ID — same OrderArray/Order schema as GetOrders. */
export function buildGetOrderRequest(orderId: string, token: string): string {
  const credentials = isOAuthToken(token)
    ? ''
    : `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>`;

  return `<?xml version="1.0" encoding="utf-8"?>
<GetOrderRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  ${credentials}
  <OrderIDArray><OrderID>${orderId}</OrderID></OrderIDArray>
  <DetailLevel>ReturnAll</DetailLevel>
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
</GetOrderRequest>`;
}

// -----------------------------------------------------------------------
// Parse orders XML -> array of sale row objects for Supabase.
// Works for both GetOrders and GetOrder responses (same OrderArray shape).
// -----------------------------------------------------------------------
export function parseOrders(xml: string): SaleRow[] {
  const rows: SaleRow[] = [];
  let txCounter = 0; // for generating synthetic IDs when eBay omits ItemID

  const ordersMatch = xml.match(/<OrderArray>([\s\S]*?)<\/OrderArray>/);
  if (!ordersMatch) return rows;

  const orderRegex = /<Order>([\s\S]*?)<\/Order>/g;
  let orderMatch: RegExpExecArray | null;

  while ((orderMatch = orderRegex.exec(ordersMatch[1])) !== null) {
    const order = orderMatch[1];

    const orderNumber =
      order.match(/<OrderID>(.*?)<\/OrderID>/)?.[1] || '';
    const buyer =
      decodeXml(order.match(/<UserID>(.*?)<\/UserID>/)?.[1] || '') || null;
    const createdTime =
      order.match(/<CreatedTime>(.*?)<\/CreatedTime>/)?.[1] || null;

    // Ship-to address — order-level, shared by every line item on the order
    const addrMatch = order.match(/<ShippingAddress>([\s\S]*?)<\/ShippingAddress>/);
    const addr = addrMatch ? addrMatch[1] : '';
    const shipToName = decodeXml(addr.match(/<Name>(.*?)<\/Name>/)?.[1] || '') || null;
    const shipToStreet1 = decodeXml(addr.match(/<Street1>(.*?)<\/Street1>/)?.[1] || '') || null;
    const shipToStreet2 = decodeXml(addr.match(/<Street2>(.*?)<\/Street2>/)?.[1] || '') || null;
    const shipToCity = decodeXml(addr.match(/<CityName>(.*?)<\/CityName>/)?.[1] || '') || null;
    const shipToState = decodeXml(addr.match(/<StateOrProvince>(.*?)<\/StateOrProvince>/)?.[1] || '') || null;
    const shipToZip = decodeXml(addr.match(/<PostalCode>(.*?)<\/PostalCode>/)?.[1] || '') || null;
    const shipToCountry = decodeXml(
      addr.match(/<CountryName>(.*?)<\/CountryName>/)?.[1] ||
      addr.match(/<Country>(.*?)<\/Country>/)?.[1] || ''
    ) || null;
    const shipToPhone = decodeXml(addr.match(/<Phone>(.*?)<\/Phone>/)?.[1] || '') || null;

    // Order-level totals + shipping service + tracking (shared across line items)
    const shippingService = decodeXml(
      order.match(/<ShippingServiceSelected>[\s\S]*?<ShippingService>(.*?)<\/ShippingService>/)?.[1] || ''
    ) || null;
    const orderSubtotal = parseNumOrNull(order, 'Subtotal');
    const orderShippingCost = parseNumOrNull(order, 'ShippingServiceCost');
    const orderTax = parseNumOrNull(order, 'SalesTaxAmount');
    const orderTotal = parseNumOrNull(order, 'Total');
    const trackingNumber = order.match(/<ShipmentTrackingNumber>(.*?)<\/ShipmentTrackingNumber>/)?.[1] || null;
    const carrier = order.match(/<ShippingCarrierUsed>(.*?)<\/ShippingCarrierUsed>/)?.[1] || null;
    const shippedAt = order.match(/<ShippedTime>(.*?)<\/ShippedTime>/)?.[1] || null;
    const salesRecordNumber = order.match(/<SalesRecordNumber>(.*?)<\/SalesRecordNumber>/)?.[1] || null;

    // Each order may contain multiple line items
    const transactionRegex = /<Transaction>([\s\S]*?)<\/Transaction>/g;
    let txMatch: RegExpExecArray | null;

    while ((txMatch = transactionRegex.exec(order)) !== null) {
      const tx = txMatch[1];

      const itemId =
        tx.match(/<ItemID>(.*?)<\/ItemID>/)?.[1] ||
        `synthetic-${orderNumber}-${++txCounter}`; // fallback so UNIQUE never hits null

      const title = decodeXml(
        tx.match(/<Title>(.*?)<\/Title>/)?.[1] || ''
      );
      const sku = decodeXml(
        tx.match(/<SKU>(.*?)<\/SKU>/)?.[1] ||
        tx.match(/<CustomLabel>(.*?)<\/CustomLabel>/)?.[1] ||
        ''
      ) || null;

      // Picture URL — eBay returns it inside <Item><PictureDetails> or <GalleryURL>
      const pictureUrl =
        tx.match(/<GalleryURL>(.*?)<\/GalleryURL>/)?.[1] ||
        tx.match(/<PictureURL>(.*?)<\/PictureURL>/)?.[1] ||
        null;

      // TransactionPrice is the per-item sale price
      const txPrice = parseFloat(
        tx.match(/<TransactionPrice[^>]*>(.*?)<\/TransactionPrice>/)?.[1] || '0'
      );
      const qty = parseInt(
        tx.match(/<QuantityPurchased>(.*?)<\/QuantityPurchased>/)?.[1] || '1'
      );
      const soldFor = txPrice * qty;

      if (title && orderNumber) {
        rows.push({
          order_number: orderNumber,
          item_title: title,
          sku,
          sold_for: soldFor,
          sale_date: createdTime,
          ebay_item_id: itemId,
          buyer,
          quantity_sold: qty,
          picture_url: pictureUrl,
          ship_to_name: shipToName,
          ship_to_street1: shipToStreet1,
          ship_to_street2: shipToStreet2,
          ship_to_city: shipToCity,
          ship_to_state: shipToState,
          ship_to_zip: shipToZip,
          ship_to_country: shipToCountry,
          ship_to_phone: shipToPhone,
          sales_record_number:
            tx.match(/<SalesRecordNumber>(.*?)<\/SalesRecordNumber>/)?.[1] || salesRecordNumber,
          shipping_service: shippingService,
          order_subtotal: orderSubtotal,
          order_shipping_cost: orderShippingCost,
          order_tax: orderTax,
          order_total: orderTotal,
          tracking_number: trackingNumber,
          carrier,
          shipped_at: shippedAt,
        });
      }
    }
  }

  return rows;
}

// -----------------------------------------------------------------------
// Fetch images via the Browse API (get_item_by_legacy_id).
// The Trading API's GetOrders/GetOrder responses don't include item photos,
// and the old Shopping API (GetMultipleItems) that used to backfill them
// was decommissioned by eBay in Feb 2025 — this replaces it. Browse API has
// no batch-by-legacy-id lookup, so items are fetched individually with
// bounded concurrency.
// -----------------------------------------------------------------------
const IMAGE_FETCH_CONCURRENCY = 5;

export async function fetchImagesForItems(itemIds: string[]): Promise<Record<string, string>> {
  if (itemIds.length === 0) return {};

  const token = await getAppAccessToken();
  const map: Record<string, string> = {};

  async function fetchOne(itemId: string) {
    try {
      const res = await fetch(
        `${ebayApiRoot()}/buy/browse/v1/item/get_item_by_legacy_id?legacy_item_id=${itemId}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
          },
        }
      );
      if (!res.ok) return;
      const data = await res.json();
      const url = data?.image?.imageUrl;
      if (url) map[itemId] = url;
    } catch {
      // ignore errors for image fetching — packing slip just renders without a photo
    }
  }

  for (let i = 0; i < itemIds.length; i += IMAGE_FETCH_CONCURRENCY) {
    const chunk = itemIds.slice(i, i + IMAGE_FETCH_CONCURRENCY);
    await Promise.all(chunk.map(fetchOne));
  }

  return map;
}

/**
 * Fetches a single order fresh from eBay's Trading API (GetOrder) and
 * upserts it into ebay_sales. Used by the item-shipped webhook when a
 * label is bought on an order that hasn't gone through the periodic
 * sold-orders sync yet (e.g. shipped within seconds of the sale).
 */
export async function fetchAndUpsertOrder(orderId: string): Promise<SaleRow[]> {
  const token = await getValidToken();
  const xml = buildGetOrderRequest(orderId, token);

  const res = await fetch(getEbayApiUrl(), {
    method: 'POST',
    headers: getEbayApiHeaders('GetOrder', token),
    body: xml,
  });
  const responseXml = await res.text();

  const ack = responseXml.match(/<Ack>(.*?)<\/Ack>/)?.[1];
  if (ack === 'Failure') {
    const errMsg =
      responseXml.match(/<LongMessage>(.*?)<\/LongMessage>/)?.[1] ||
      responseXml.match(/<ShortMessage>(.*?)<\/ShortMessage>/)?.[1] ||
      'eBay GetOrder API error';
    if (isEbayAuthError(responseXml)) clearTokenCache();
    throw new Error(decodeXml(errMsg));
  }

  const rows = parseOrders(responseXml);
  if (rows.length === 0) return [];

  const realItemIds = Array.from(new Set(
    rows
      .map((r) => r.ebay_item_id)
      .filter((id): id is string => id !== null && !id.startsWith('synthetic-'))
  ));
  if (realItemIds.length > 0) {
    const imageMap = await fetchImagesForItems(realItemIds);
    for (const row of rows) {
      if (row.ebay_item_id && imageMap[row.ebay_item_id]) {
        row.picture_url = imageMap[row.ebay_item_id];
      }
    }
  }

  const { error } = await supabaseAdmin
    .from('ebay_sales')
    .upsert(
      rows.map((r) => ({ ...r, synced_at: new Date().toISOString() })),
      { onConflict: 'order_number,ebay_item_id', ignoreDuplicates: true }
    );
  if (error) throw error;

  return rows;
}
