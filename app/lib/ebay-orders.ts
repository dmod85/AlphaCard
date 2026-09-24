import {
  getValidToken,
  isOAuthToken,
  getEbayApiHeaders,
  getEbayApiUrl,
  clearTokenCache,
} from '@/app/lib/ebay-auth';
import { supabaseAdmin } from '@/app/lib/supabase-admin';
import { getAppAccessToken, ebayApiRoot } from '@/app/lib/ebay-app-token';
import { applyCostDefaultsToRow, DEFAULT_PNL_SETTINGS, type PnlSettings } from '@/app/lib/pnl';

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
  ebay_fee: number | null;
  // Seller postage from GetOrders (ActualShippingCost / eBay label cost), not buyer-paid shipping.
  shipping_cost: number | null;
}

/** Parses a numeric XML field, returning null (not 0) when absent so we don't overwrite unknowns. */
export function parseNumOrNull(str: string, tag: string): number | null {
  const m = str.match(new RegExp(`<${tag}[^>]*>(.*?)<\\/${tag}>`));
  return m ? parseFloat(m[1]) : null;
}

function positiveAmount(n: number | null | undefined): number | null {
  return n != null && Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Seller postage hints from GetOrders — NEVER ActualShippingCost / ShippingServiceCost
 * (those are what the buyer paid).
 *
 * Real seller-paid eBay label charges come from the Finances API
 * (see fetchSellerLabelCosts). This only keeps:
 * 1. eBayEstimatedLabelCost when eBay actually returns a positive label price
 * 2. GSP/EIS domestic-leg TotalShippingCost (seller pays to get the package to the hub)
 */
export function pickSellerShippingCost(txXml: string, orderXml: string): number | null {
  const labelCost =
    positiveAmount(parseNumOrNull(txXml, 'eBayEstimatedLabelCost')) ??
    positiveAmount(parseNumOrNull(orderXml, 'eBayEstimatedLabelCost'));
  if (labelCost != null) return labelCost;

  const gspMatch = orderXml.match(
    /<SellerShipmentToLogisticsProvider>[\s\S]*?<TotalShippingCost[^>]*>(.*?)<\/TotalShippingCost>/
  );
  return gspMatch ? positiveAmount(parseFloat(gspMatch[1])) : null;
}

export function buildGetOrdersRequest(
  fromDate: string,
  toDate: string,
  page: number,
  token: string,
  orderStatus = 'Completed'
): string {
  const credentials = isOAuthToken(token)
    ? ''
    : `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>`;

  return `<?xml version="1.0" encoding="utf-8"?>
<GetOrdersRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  ${credentials}
  <CreateTimeFrom>${fromDate}</CreateTimeFrom>
  <CreateTimeTo>${toDate}</CreateTimeTo>
  <OrderStatus>${orderStatus}</OrderStatus>
  <IncludeFinalValueFee>true</IncludeFinalValueFee>
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
  <IncludeFinalValueFee>true</IncludeFinalValueFee>
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
      decodeXml(
        order.match(/<Buyer>[\s\S]*?<UserID>(.*?)<\/UserID>/)?.[1] ||
        order.match(/<UserID>(.*?)<\/UserID>/)?.[1] ||
        ''
      ) || null;
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
    const salesRecordNumber =
      order.match(/<SellingManagerSalesRecordNumber>(.*?)<\/SellingManagerSalesRecordNumber>/)?.[1] ||
      order.match(/<SalesRecordNumber>(.*?)<\/SalesRecordNumber>/)?.[1] ||
      null;

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
      const ebayFee = parseNumOrNull(tx, 'FinalValueFee');
      const shippingCost = pickSellerShippingCost(tx, order);

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
            tx.match(/<SellingManagerSalesRecordNumber>(.*?)<\/SellingManagerSalesRecordNumber>/)?.[1] ||
            tx.match(/<SalesRecordNumber>(.*?)<\/SalesRecordNumber>/)?.[1] ||
            salesRecordNumber,
          shipping_service: shippingService,
          order_subtotal: orderSubtotal,
          order_shipping_cost: orderShippingCost,
          order_tax: orderTax,
          order_total: orderTotal,
          tracking_number: trackingNumber,
          carrier,
          shipped_at: shippedAt,
          ebay_fee: ebayFee,
          shipping_cost: shippingCost,
        });
      }
    }
  }

  return rows;
}

// -----------------------------------------------------------------------
// Listing photos. GetOrders / GetOrder never include PictureURL, so every
// import has to look the photo up. Browse API get_item_by_legacy_id is the
// usual source. GetItem is the fallback for listings Browse will not return.
// The old Shopping API (GetMultipleItems) was decommissioned in Feb 2025.
// Neither API has a batch-by-legacy-id call, so items are fetched with
// bounded concurrency.
//
// Upserts use ignoreDuplicates, which keeps a curated SKU but also keeps a
// null picture_url. Callers must backfill picture_url on rows that are
// still blank, or a label import that lands first never gains a photo.
// -----------------------------------------------------------------------
const IMAGE_FETCH_CONCURRENCY = 5;

function firstXmlValue(xml: string, tag: string): string | null {
  const raw = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`))?.[1];
  if (!raw) return null;
  const cdata = raw.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  const value = decodeXml((cdata ? cdata[1] : raw).trim());
  return value || null;
}

function realItemIds(ids: Array<string | null | undefined>): string[] {
  return Array.from(new Set(
    ids.filter((id): id is string => !!id && !id.startsWith('synthetic-'))
  ));
}

async function mapInChunks(
  itemIds: string[],
  fetchOne: (itemId: string) => Promise<void>
): Promise<void> {
  for (let i = 0; i < itemIds.length; i += IMAGE_FETCH_CONCURRENCY) {
    const chunk = itemIds.slice(i, i + IMAGE_FETCH_CONCURRENCY);
    await Promise.all(chunk.map(fetchOne));
  }
}

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
      // A missing photo leaves the thumbnail blank; the sale itself still imports.
    }
  }

  await mapInChunks(itemIds, fetchOne);
  return map;
}

/** Seller's own Trading-API GetItem. Works for sold listings Browse no longer serves. */
export async function fetchImagesViaGetItem(itemIds: string[]): Promise<Record<string, string>> {
  if (itemIds.length === 0) return {};

  const token = await getValidToken();
  const credentials = isOAuthToken(token)
    ? ''
    : `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>`;
  const map: Record<string, string> = {};

  async function fetchOne(itemId: string) {
    try {
      const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  ${credentials}
  <ItemID>${itemId}</ItemID>
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
</GetItemRequest>`;
      const res = await fetch(getEbayApiUrl(), {
        method: 'POST',
        headers: getEbayApiHeaders('GetItem', token),
        body: xml,
      });
      const text = await res.text();
      const url = firstXmlValue(text, 'PictureURL') || firstXmlValue(text, 'GalleryURL');
      if (url) map[itemId] = url;
    } catch {
      // Same as Browse: skip the photo rather than fail the import.
    }
  }

  await mapInChunks(itemIds, fetchOne);
  return map;
}

/** Fills picture_url on rows that do not already have one. */
export async function attachListingPictures(rows: SaleRow[]): Promise<void> {
  const needIds = realItemIds(rows.filter((row) => !row.picture_url).map((row) => row.ebay_item_id));
  if (needIds.length === 0) return;

  let imageMap: Record<string, string> = {};
  try {
    imageMap = await fetchImagesForItems(needIds);
  } catch (err) {
    console.error('[ebay-orders] browse photos:', err instanceof Error ? err.message : err);
  }

  const stillMissing = needIds.filter((id) => !imageMap[id]);
  if (stillMissing.length > 0) {
    try {
      Object.assign(imageMap, await fetchImagesViaGetItem(stillMissing));
    } catch (err) {
      console.error('[ebay-orders] GetItem photos:', err instanceof Error ? err.message : err);
    }
  }

  for (const row of rows) {
    if (!row.picture_url && row.ebay_item_id && imageMap[row.ebay_item_id]) {
      row.picture_url = imageMap[row.ebay_item_id];
    }
  }
}

/**
 * Writes picture_url onto existing ebay_sales rows that are still blank.
 * ignoreDuplicates inserts will not do this themselves.
 */
export async function backfillMissingPictures(rows: SaleRow[]): Promise<number> {
  const byKey = new Map<string, string>();
  for (const row of rows) {
    if (!row.picture_url || !row.order_number || !row.ebay_item_id) continue;
    byKey.set(`${row.order_number}||${row.ebay_item_id}`, row.picture_url);
  }
  if (byKey.size === 0) return 0;

  const orderNumbers = Array.from(new Set(rows.map((row) => row.order_number).filter(Boolean)));
  let updated = 0;
  const CHUNK = 40;
  for (let i = 0; i < orderNumbers.length; i += CHUNK) {
    const chunk = orderNumbers.slice(i, i + CHUNK);
    const { data, error } = await supabaseAdmin
      .from('ebay_sales')
      .select('order_number, ebay_item_id')
      .in('order_number', chunk)
      .is('picture_url', null);
    if (error) {
      console.error('[ebay-orders] picture backfill lookup:', error.message);
      continue;
    }
    for (const existing of data ?? []) {
      const url = byKey.get(`${existing.order_number}||${existing.ebay_item_id}`);
      if (!url) continue;
      const { error: updateError } = await supabaseAdmin
        .from('ebay_sales')
        .update({ picture_url: url })
        .eq('order_number', existing.order_number)
        .eq('ebay_item_id', existing.ebay_item_id)
        .is('picture_url', null);
      if (updateError) {
        console.error('[ebay-orders] picture backfill:', updateError.message);
        continue;
      }
      updated += 1;
    }
  }
  return updated;
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

  const settings = await loadPnlSettings();

  await attachListingPictures(rows);

  const { error } = await supabaseAdmin
    .from('ebay_sales')
    .upsert(
      rows.map((r) => ({
        ...applyCostDefaultsToRow(r, settings),
        synced_at: new Date().toISOString(),
      })),
      { onConflict: 'order_number,ebay_item_id', ignoreDuplicates: true }
    );
  if (error) throw error;
  await backfillMissingPictures(rows);

  return rows;
}

export async function loadPnlSettings(): Promise<PnlSettings> {
  try {
    const { data } = await supabaseAdmin
      .from('pnl_settings')
      .select('*')
      .eq('id', 1)
      .maybeSingle();
    if (!data) return DEFAULT_PNL_SETTINGS;
    return {
      id: 1,
      default_shipping_cost: Number(data.default_shipping_cost),
      default_supplies_cost: Number(data.default_supplies_cost),
      default_fee_rate: Number(data.default_fee_rate),
      default_processing_fee: Number(data.default_processing_fee),
      default_ad_rate: Number(data.default_ad_rate),
    };
  } catch {
    return DEFAULT_PNL_SETTINGS;
  }
}

/** Pull the last few days of eBay orders so a just-purchased label can be matched to a sale. */
export async function syncRecentSales(days = 2): Promise<number> {
  const toDate = new Date();
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - days);
  const token = await getValidToken();
  const fromIso = fromDate.toISOString();
  const toIso = toDate.toISOString();

  const rows: SaleRow[] = [];
  let page = 1;
  let totalPages = 1;
  do {
    const xml = buildGetOrdersRequest(fromIso, toIso, page, token, 'All');
    const res = await fetch(getEbayApiUrl(), {
      method: 'POST',
      headers: getEbayApiHeaders('GetOrders', token),
      body: xml,
    });
    const responseXml = await res.text();
    const ack = responseXml.match(/<Ack>(.*?)<\/Ack>/)?.[1];
    if (ack === 'Failure') {
      const errMsg =
        responseXml.match(/<LongMessage>(.*?)<\/LongMessage>/)?.[1] ||
        responseXml.match(/<ShortMessage>(.*?)<\/ShortMessage>/)?.[1] ||
        'eBay API error';
      throw new Error(decodeXml(errMsg));
    }
    totalPages = parseInt(
      responseXml.match(/<TotalNumberOfPages>(.*?)<\/TotalNumberOfPages>/)?.[1] || '1',
      10
    );
    rows.push(...parseOrders(responseXml));
    page += 1;
  } while (page <= totalPages && page <= 3);

  const seen = new Set<string>();
  const uniqueRows = rows.filter((r) => {
    const key = `${r.order_number}||${r.ebay_item_id ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (uniqueRows.length === 0) return 0;

  await attachListingPictures(uniqueRows);

  const settings = await loadPnlSettings();
  const { error } = await supabaseAdmin.from('ebay_sales').upsert(
    uniqueRows.map((r) => ({
      ...applyCostDefaultsToRow(r, settings),
      synced_at: new Date().toISOString(),
    })),
    { onConflict: 'order_number,ebay_item_id', ignoreDuplicates: true }
  );
  if (error) throw new Error(error.message);

  for (const r of uniqueRows) {
    const patch: Record<string, unknown> = {};
    if (r.buyer) patch.buyer = r.buyer;
    if (r.ship_to_name) patch.ship_to_name = r.ship_to_name;
    if (r.ship_to_street1) patch.ship_to_street1 = r.ship_to_street1;
    if (r.ship_to_street2) patch.ship_to_street2 = r.ship_to_street2;
    if (r.ship_to_city) patch.ship_to_city = r.ship_to_city;
    if (r.ship_to_state) patch.ship_to_state = r.ship_to_state;
    if (r.ship_to_zip) patch.ship_to_zip = r.ship_to_zip;
    if (r.ship_to_country) patch.ship_to_country = r.ship_to_country;
    if (r.shipping_service) patch.shipping_service = r.shipping_service;
    if (r.tracking_number) patch.tracking_number = r.tracking_number;
    if (r.carrier) patch.carrier = r.carrier;
    if (r.shipped_at) patch.shipped_at = r.shipped_at;
    if (r.order_subtotal != null) patch.order_subtotal = r.order_subtotal;
    if (r.order_shipping_cost != null) patch.order_shipping_cost = r.order_shipping_cost;
    if (r.order_tax != null) patch.order_tax = r.order_tax;
    if (r.order_total != null) patch.order_total = r.order_total;
    if (r.sales_record_number) patch.sales_record_number = r.sales_record_number;
    if (Object.keys(patch).length === 0) continue;
    let q = supabaseAdmin.from('ebay_sales').update(patch).eq('order_number', r.order_number);
    if (r.ebay_item_id) q = q.eq('ebay_item_id', r.ebay_item_id);
    await q;
  }

  await backfillMissingPictures(uniqueRows);
  return uniqueRows.length;
}
