import 'server-only';
import { supabaseAdmin } from '@/app/lib/supabase-admin';
import { generatePackingSlipPdf, PackingSlipOrder } from '@/app/lib/packing-slip';

/** Fields from ebay_sales that the packing slip needs. */
export interface SlipSaleRow {
  order_number: string;
  sales_record_number: string | null;
  sale_date: string | null;
  buyer: string | null;
  ship_to_name: string | null;
  ship_to_street1: string | null;
  ship_to_street2: string | null;
  ship_to_city: string | null;
  ship_to_state: string | null;
  ship_to_zip: string | null;
  ship_to_country: string | null;
  shipping_service: string | null;
  order_subtotal: number | null;
  order_shipping_cost: number | null;
  order_tax: number | null;
  order_total: number | null;
  item_title: string;
  sku: string | null;
  ebay_item_id: string | null;
  quantity_sold: number;
  sold_for: number;
  picture_url: string | null;
  printed_at?: string | null;
}

export type SlipPrintStateRow = { printed_at?: string | null };

export type RegeneratedSlip = {
  bytes: Uint8Array;
  url: string;
  alreadyPrinted: boolean;
};

export type UpdateRowsOption = boolean | ((state: { alreadyPrinted: boolean }) => boolean);

export type RegenerateSlipOptions = {
  /** Default true. Pass a function to decide after printed_at is known. */
  updateRows?: UpdateRowsOption;
  /** Default true (fail closed). View/save passes false so a storage hiccup still returns the PDF. */
  throwOnStoreError?: boolean;
};

/** True if any line for the order has already been marked printed. */
export function orderAlreadyPrinted(rows: readonly SlipPrintStateRow[]): boolean {
  return rows.some((row) => row.printed_at != null && row.printed_at !== '');
}

/** Reprints of already-printed orders go through the queue; first prints use the auto listener. */
export function shouldQueuePrint(alreadyPrinted: boolean): boolean {
  return alreadyPrinted;
}

/** Viewing/saving must not UPDATE ebay_sales on an unprinted order (that would auto-print). */
export function shouldUpdateRowsOnView(alreadyPrinted: boolean): boolean {
  return alreadyPrinted;
}

export function resolveUpdateRows(updateRows: UpdateRowsOption, alreadyPrinted: boolean): boolean {
  return typeof updateRows === 'function' ? updateRows({ alreadyPrinted }) : updateRows;
}

export function buildSlipOrder(
  rows: readonly SlipSaleRow[],
  store: { storeName?: string | null; storeUrl?: string | null } = {
    storeName: process.env.STORE_NAME,
    storeUrl: process.env.STORE_URL,
  },
): PackingSlipOrder {
  if (!rows.length) {
    throw new Error('No sales rows to build a packing slip');
  }

  const first = rows[0];
  return {
    orderNumber: first.order_number,
    salesRecordNumber: first.sales_record_number,
    saleDate: first.sale_date,
    buyer: first.buyer,
    shipTo: {
      name: first.ship_to_name,
      street1: first.ship_to_street1,
      street2: first.ship_to_street2,
      city: first.ship_to_city,
      state: first.ship_to_state,
      zip: first.ship_to_zip,
      country: first.ship_to_country,
    },
    shippingService: first.shipping_service,
    subtotal: first.order_subtotal,
    shippingCost: first.order_shipping_cost,
    tax: first.order_tax,
    total: first.order_total,
    items: rows.map((r) => ({
      title: r.item_title,
      sku: r.sku,
      ebayItemId: r.ebay_item_id,
      quantity: r.quantity_sold,
      soldFor: r.sold_for,
      pictureUrl: r.picture_url,
    })),
    storeName: store.storeName?.trim() || 'Packing Slip',
    storeUrl: store.storeUrl?.trim() || null,
  };
}

function versionedPublicUrl(publicUrl: string): string {
  const versioned = new URL(publicUrl);
  versioned.searchParams.set('v', String(Date.now()));
  return versioned.toString();
}

/**
 * Rebuild the packing slip with the current layout and overwrite the stored PDF.
 * Optionally points every ebay_sales row for the order at a cache-busted public URL.
 * Does not touch printed_at.
 *
 * @returns the PDF bytes, public URL, and printed state, or null when the order has no rows
 */
export async function regenerateAndStoreSlip(
  orderNumber: string,
  options: RegenerateSlipOptions = {},
): Promise<RegeneratedSlip | null> {
  const updateRowsOption: UpdateRowsOption = options.updateRows ?? true;
  const throwOnStoreError = options.throwOnStoreError ?? true;

  const { data: rows, error } = await supabaseAdmin
    .from('ebay_sales')
    .select('*')
    .eq('order_number', orderNumber);
  if (error) throw error;
  if (!rows || rows.length === 0) return null;

  const alreadyPrinted = orderAlreadyPrinted(rows);
  const updateRows = resolveUpdateRows(updateRowsOption, alreadyPrinted);

  const order = buildSlipOrder(rows);
  const pdfBytes = await generatePackingSlipPdf(order);
  const path = `${orderNumber}.pdf`;

  const { data: publicUrlData } = supabaseAdmin.storage.from('packing-slips').getPublicUrl(path);
  const url = versionedPublicUrl(publicUrlData.publicUrl);

  const { error: uploadErr } = await supabaseAdmin.storage
    .from('packing-slips')
    .upload(path, Buffer.from(pdfBytes), {
      contentType: 'application/pdf',
      upsert: true,
      cacheControl: '0',
    });
  if (uploadErr) {
    if (throwOnStoreError) throw uploadErr;
    console.error(`[packing-slip] failed to upload slip for ${orderNumber}:`, uploadErr.message);
    return { bytes: pdfBytes, url, alreadyPrinted };
  }

  if (updateRows) {
    const { error: updateErr } = await supabaseAdmin
      .from('ebay_sales')
      .update({
        packing_slip_generated_at: new Date().toISOString(),
        packing_slip_url: url,
      })
      .eq('order_number', orderNumber);
    if (updateErr) {
      if (throwOnStoreError) throw updateErr;
      console.error(`[packing-slip] failed to update slip URL for ${orderNumber}:`, updateErr.message);
    }
  }

  return { bytes: pdfBytes, url, alreadyPrinted };
}
