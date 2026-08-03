import 'server-only';
import {
  PDFDocument,
  PDFFont,
  StandardFonts,
  rgb,
  pushGraphicsState,
  popGraphicsState,
  concatTransformationMatrix,
} from 'pdf-lib';

// Physical page = the label stock actually loaded in the printer: 4.25" x 5.5".
const PAGE_W = 4.25 * 72; // 306pt
const PAGE_H = 5.5 * 72; // 396pt

// The printer feeds this stock such that content needs to be rotated 90°
// to print right-side-up, so instead of relying on the PDF's page-level
// /Rotate flag (support for which varies across print pipelines/drivers),
// the whole layout below is authored in normal upright coordinates and
// baked into the content stream pre-rotated via a single transform matrix
// pushed once at the top of the page. Flip ROTATE_CW to reverse direction
// if it comes out backwards on your printer.
const ROTATE_CW = true;

export interface PackingSlipItem {
  title: string;
  sku: string | null;
  ebayItemId: string | null;
  quantity: number;
  soldFor: number;
  pictureUrl: string | null;
}

export interface PackingSlipOrder {
  orderNumber: string;
  salesRecordNumber: string | null;
  saleDate: string | null;
  shipTo: {
    name: string | null;
    street1: string | null;
    street2: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    country: string | null;
  };
  shippingService: string | null;
  subtotal: number | null;
  shippingCost: number | null;
  tax: number | null;
  total: number | null;
  items: PackingSlipItem[];
  storeName: string;
  storeUrl?: string | null;
}

function fmt$(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return `$${n.toFixed(2)}`;
}

async function embedItemImage(pdfDoc: PDFDocument, url: string | null) {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('png') || url.toLowerCase().endsWith('.png')) {
      return await pdfDoc.embedPng(bytes);
    }
    return await pdfDoc.embedJpg(bytes);
  } catch {
    return null;
  }
}

async function embedQrCode(pdfDoc: PDFDocument, data: string) {
  try {
    const QRCode = (await import('qrcode')).default;
    const pngBuffer = await QRCode.toBuffer(data, { margin: 0, width: 200 });
    return await pdfDoc.embedPng(pngBuffer);
  } catch {
    return null;
  }
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (current && font.widthOfTextAtSize(test, size) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Generates a 4.25"x5.5" packing slip PDF for one order, content rotated 90°.
 */
export async function generatePackingSlipPdf(order: PackingSlipOrder): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([PAGE_W, PAGE_H]);

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const matrix: [number, number, number, number, number, number] = ROTATE_CW
    ? [0, 1, -1, 0, PAGE_H, 0]
    : [0, -1, 1, 0, 0, PAGE_W];
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...matrix));

  const gray = rgb(0.45, 0.45, 0.45);
  const black = rgb(0.1, 0.1, 0.1);
  const lightGray = rgb(0.82, 0.82, 0.82);

  const M = 10; // tight outer margin — minimize white space
  let y = PAGE_H - M;

  // ---- Header ---------------------------------------------------------
  page.drawText(order.storeName, { x: M, y: y - 12, size: 13, font: fontBold, color: black });
  page.drawText('PACKING SLIP', { x: PAGE_W - M - 74, y: y - 9, size: 7, font, color: gray });

  const qrImage = order.storeUrl ? await embedQrCode(pdfDoc, order.storeUrl) : null;
  const qrSize = 38;
  if (qrImage) {
    page.drawImage(qrImage, { x: PAGE_W - M - qrSize, y: y - 14 - qrSize, width: qrSize, height: qrSize });
  }
  y -= 12 + 14;

  page.drawLine({ start: { x: M, y }, end: { x: PAGE_W - M, y }, thickness: 0.75, color: lightGray });
  y -= 12;

  // ---- Ship to ----------------------------------------------------------
  page.drawText('SHIP TO', { x: M, y, size: 6.5, font: fontBold, color: gray });
  y -= 11;
  const shipToLines = [
    order.shipTo.name,
    order.shipTo.street1,
    order.shipTo.street2,
    [order.shipTo.city, order.shipTo.state, order.shipTo.zip].filter(Boolean).join(', '),
    order.shipTo.country,
  ].filter((l): l is string => !!l && l.trim().length > 0);

  for (const line of shipToLines) {
    page.drawText(line, { x: M, y, size: 9.5, font: fontBold, color: black });
    y -= 12;
  }
  y -= 3;

  page.drawLine({ start: { x: M, y }, end: { x: PAGE_W - M, y }, thickness: 0.75, color: lightGray });
  y -= 12;

  // ---- Order meta ---------------------------------------------------------
  page.drawText(`Order: ${order.orderNumber}`, { x: M, y, size: 9, font: fontBold, color: black });
  const dateStr = order.saleDate
    ? new Date(order.saleDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '';
  if (dateStr) {
    page.drawText(`Order date: ${dateStr}`, {
      x: PAGE_W - M - font.widthOfTextAtSize(`Order date: ${dateStr}`, 7.5),
      y: y + 1,
      size: 7.5,
      font,
      color: gray,
    });
  }
  y -= 11;
  if (order.salesRecordNumber) {
    page.drawText(`Sales record #: ${order.salesRecordNumber}`, { x: M, y, size: 7, font, color: gray });
    y -= 10;
  }
  y -= 4;

  page.drawLine({ start: { x: M, y }, end: { x: PAGE_W - M, y }, thickness: 0.75, color: lightGray });
  y -= 10;

  // ---- Items --------------------------------------------------------------
  const imgSize = 32;
  for (const item of order.items) {
    const rowTop = y;
    const img = await embedItemImage(pdfDoc, item.pictureUrl);
    if (img) {
      const scaled = img.scaleToFit(imgSize, imgSize);
      page.drawImage(img, {
        x: M,
        y: rowTop - imgSize + (imgSize - scaled.height),
        width: scaled.width,
        height: scaled.height,
      });
    }

    const textX = M + imgSize + 6;
    const priceColX = PAGE_W - M - 42;
    const qtyColX = PAGE_W - M - 62;
    const textWidth = qtyColX - textX - 4;

    const titleLines = wrapText(item.title, font, 7.5, textWidth).slice(0, 2);
    let ty = rowTop - 8;
    for (const line of titleLines) {
      page.drawText(line, { x: textX, y: ty, size: 7.5, font, color: black });
      ty -= 9;
    }
    const skuLabel = item.sku ? `SKU: ${item.sku}` : item.ebayItemId ? `Item: ${item.ebayItemId}` : '';
    if (skuLabel) {
      page.drawText(skuLabel, { x: textX, y: rowTop - imgSize + 3, size: 6, font, color: gray });
    }

    page.drawText(`x${item.quantity}`, { x: qtyColX, y: rowTop - 8, size: 7.5, font, color: black });
    page.drawText(fmt$(item.soldFor), { x: priceColX, y: rowTop - 8, size: 7.5, font: fontBold, color: black });

    y = rowTop - imgSize - 5;
  }

  page.drawLine({ start: { x: M, y }, end: { x: PAGE_W - M, y }, thickness: 0.75, color: lightGray });
  y -= 10;

  // ---- Shipping service -----------------------------------------------------
  if (order.shippingService) {
    page.drawText(`Ship via: ${order.shippingService}`, { x: M, y, size: 7, font, color: gray });
    y -= 11;
  }

  // ---- Totals ------------------------------------------------------------
  const totalsRows: [string, number | null][] = [
    ['Subtotal', order.subtotal],
    ['Shipping', order.shippingCost],
    ['Tax', order.tax],
  ];
  for (const [label, val] of totalsRows) {
    if (val === null) continue;
    page.drawText(label, { x: PAGE_W - M - 90, y, size: 7, font, color: gray });
    page.drawText(fmt$(val), { x: PAGE_W - M - 36, y, size: 7, font, color: black });
    y -= 9.5;
  }
  if (order.total !== null) {
    page.drawText('Order total', { x: PAGE_W - M - 90, y, size: 8.5, font: fontBold, color: black });
    page.drawText(fmt$(order.total), { x: PAGE_W - M - 36, y, size: 8.5, font: fontBold, color: black });
    y -= 11;
  }

  page.pushOperators(popGraphicsState());

  return pdfDoc.save();
}
