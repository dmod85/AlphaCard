import { NextRequest, NextResponse } from 'next/server';
import {
  getValidToken,
  isOAuthToken,
  getEbayApiHeaders,
  getEbayApiUrl,
  clearTokenCache,
} from '@/app/lib/ebay-auth';
import { supabaseAdmin } from '@/app/lib/supabase-admin';

// -----------------------------------------------------------------------
// eBay Trading API: GetOrders with OrderStatus=Completed
// Pulls sold orders, upserts into ebay_sales, returns all DB rows.
//
// GET  /api/ebay/sold-orders          — sync from eBay + return DB rows
//   ?days=90   — lookback in days (default 90, max 90 per eBay limit)
//   ?page=1    — eBay page of results
//   ?sync=false — skip eBay call, just return DB rows
//
// PATCH /api/ebay/sold-orders         — update a single sale's SKU
//   body: { id, sku }
// -----------------------------------------------------------------------

const EBAY_AUTH_ERROR_CODES = ['21917053', '21916984', '21917055'];

function isEbayAuthError(xml: string): boolean {
  return EBAY_AUTH_ERROR_CODES.some((c) => xml.includes(`<ErrorCode>${c}</ErrorCode>`))
    || /validation of the authentication token/i.test(xml);
}

function decodeXml(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

// -----------------------------------------------------------------------
// Build GetOrders XML request
// -----------------------------------------------------------------------
function buildGetOrdersRequest(
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

// -----------------------------------------------------------------------
// Parse orders XML -> array of sale row objects for Supabase
// -----------------------------------------------------------------------
interface SaleRow {
  order_number: string;
  item_title: string;
  sku: string | null;
  sold_for: number;
  sale_date: string | null;
  ebay_item_id: string | null;
  buyer: string | null;
  quantity_sold: number;
  picture_url: string | null;
}

function parseOrders(xml: string): SaleRow[] {
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
        });
      }
    }
  }

  return rows;
}

// -----------------------------------------------------------------------
// GET handler — sync from eBay and/or return DB rows
// -----------------------------------------------------------------------
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const days = Math.min(parseInt(searchParams.get('days') || '90', 10), 90);
    const page = parseInt(searchParams.get('page') || '1', 10);
    const shouldSync = searchParams.get('sync') !== 'false';

    // If not syncing, just return DB rows
    if (!shouldSync) {
      const { data, error } = await supabaseAdmin
        .from('ebay_sales')
        .select('*')
        .order('sale_date', { ascending: false });
      if (error) throw error;
      return NextResponse.json({ sales: data ?? [], synced: 0 });
    }

    // Build date range:
    // toDate   = right now
    // fromDate = midnight (start of day) X days ago — so the full day is included
    const toDate = new Date();
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - days);
    fromDate.setHours(0, 0, 0, 0); // include the entire starting day

    const token = await getValidToken();
    const xml = buildGetOrdersRequest(
      fromDate.toISOString(),
      toDate.toISOString(),
      page,
      token
    );

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
      console.error('[sold-orders] eBay API failure:', decodeXml(errMsg));
      if (isEbayAuthError(responseXml)) {
        clearTokenCache();
        return NextResponse.json({ error: 'EBAY_AUTH_REQUIRED' }, { status: 401 });
      }
      return NextResponse.json({ error: decodeXml(errMsg) }, { status: 500 });
    }

    const totalPages = parseInt(
      responseXml.match(/<TotalNumberOfPages>(.*?)<\/TotalNumberOfPages>/)?.[1] || '1'
    );

    const rows = parseOrders(responseXml);

    // Deduplicate within the batch — Postgres raises an error if the same
    // conflict key appears more than once in a single upsert payload.
    const seen = new Set<string>();
    const uniqueRows = rows.filter(r => {
      const key = `${r.order_number}||${r.ebay_item_id ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Insert only NEW rows — ignoreDuplicates:true skips existing (order_number, ebay_item_id)
    // so we never overwrite manually-edited SKUs and the synced count reflects truly new rows.
    let synced = 0;
    if (uniqueRows.length > 0) {
      const { data: inserted, error: upsertError } = await supabaseAdmin
        .from('ebay_sales')
        .upsert(
          uniqueRows.map((r) => ({ ...r, synced_at: new Date().toISOString() })),
          { onConflict: 'order_number,ebay_item_id', ignoreDuplicates: true }
        )
        .select('id');
      if (upsertError) {
        console.error('[sold-orders] upsert error:', upsertError.message);
      } else {
        // Only rows actually inserted (not skipped) are returned when ignoreDuplicates:true
        synced = inserted?.length ?? 0;
      }
    }

    // Return all DB rows (not just the synced page)
    const { data: allSales, error: fetchErr } = await supabaseAdmin
      .from('ebay_sales')
      .select('*')
      .order('sale_date', { ascending: false });
    if (fetchErr) throw fetchErr;

    return NextResponse.json({
      sales: allSales ?? [],
      synced,
      totalPages,
      currentPage: page,
    });
  } catch (err: any) {
    if (err.message === 'EBAY_AUTH_REQUIRED') {
      return NextResponse.json({ error: 'EBAY_AUTH_REQUIRED' }, { status: 401 });
    }
    return NextResponse.json(
      { error: err.message || 'Internal server error' },
      { status: 500 }
    );
  }
}

// -----------------------------------------------------------------------
// PATCH handler — update sku (and optionally other fields) on a sale row
// body: { id: string; sku: string }
// -----------------------------------------------------------------------
export async function PATCH(request: NextRequest) {
  try {
    const { id, sku } = await request.json();
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

    const { data, error } = await supabaseAdmin
      .from('ebay_sales')
      .update({ sku: sku ?? null })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return NextResponse.json({ sale: data });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
