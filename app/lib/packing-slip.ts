import 'server-only';
import fs from 'fs';
import path from 'path';
import {
  PDFDocument,
  PDFPage,
  PDFFont,
  PDFImage,
  StandardFonts,
  rgb,
  pushGraphicsState,
  popGraphicsState,
  concatTransformationMatrix,
} from 'pdf-lib';

// The physical PDF page is a full, plain portrait Letter sheet (8.5"x11").
// It's deliberately NOT shaped like the 8.5"x5.5" half-slip itself — a
// landscape-shaped page makes browsers/print drivers auto-switch physical
// print orientation to Landscape, which stacks a second, unwanted rotation
// on top of the one already baked into the content below and clips content
// off the edge. A plain portrait Letter page needs no orientation guessing:
// it's the standard shape every printer expects by default.
const LETTER_W = 8.5 * 72; // 612pt
const LETTER_H = 11 * 72; // 792pt
const HALF_H = 5.5 * 72; // 396pt — height of each half-sheet slip

// Print this at 100% ("Actual size", not "Fit to page") on a standard
// portrait Letter sheet, then cut once across the middle — no quartering.
// The top half is the slip; the bottom half is intentionally left blank
// (a spot for a second slip if this is ever extended to 2-up printing).
//
// Each half's content is authored on a portrait "logical" canvas — the
// half's dimensions swapped — and baked into the content stream
// pre-rotated via a transform matrix, so it reads correctly once you
// physically turn the cut half-sheet 90° in hand. Flip ROTATE_CW to
// reverse direction if it comes out backwards on your printer.
const ROTATE_CW = true;
const LOGICAL_W = HALF_H; // 396pt (5.5") — logical canvas width
const LOGICAL_H = LETTER_W; // 612pt (8.5") — logical canvas height

// Drop a logo at one of these paths (relative to the repo's public/ dir) to
// have it appear centered in the header. Falls back to store-name text only
// when none is found.
const LOGO_CANDIDATES = ['logo.png', 'logo.jpg', 'logo.jpeg'];

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
  buyer?: string | null;
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

function centerX(font: PDFFont, text: string, size: number, centerAt: number): number {
  return centerAt - font.widthOfTextAtSize(text, size) / 2;
}

function rightX(font: PDFFont, text: string, size: number, rightEdge: number): number {
  return rightEdge - font.widthOfTextAtSize(text, size);
}

async function embedLogo(pdfDoc: PDFDocument): Promise<PDFImage | null> {
  for (const name of LOGO_CANDIDATES) {
    const filePath = path.join(process.cwd(), 'public', name);
    try {
      const bytes = fs.readFileSync(filePath);
      return name.endsWith('.png') ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
    } catch {
      // try next candidate
    }
  }
  return null;
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

/** Draws one order's slip content into a half-sheet region, rotated 90°, with its physical bottom edge at y=offsetY. */
async function drawSlip(
  page: PDFPage,
  pdfDoc: PDFDocument,
  order: PackingSlipOrder,
  font: PDFFont,
  fontBold: PDFFont,
  offsetY: number
) {
  const matrix: [number, number, number, number, number, number] = ROTATE_CW
    ? [0, 1, -1, 0, LOGICAL_H, offsetY]
    : [0, -1, 1, 0, offsetY, LOGICAL_W];
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...matrix));

  const gray = rgb(0.45, 0.45, 0.45);
  const black = rgb(0.1, 0.1, 0.1);
  const lightGray = rgb(0.82, 0.82, 0.82);
  const boxFill = rgb(0.95, 0.96, 0.97);
  const accent = rgb(0.13, 0.29, 0.72); // brand-blue accent for section labels

  const M = 8; // tight outer margin — minimize white space
  const centerLineX = LOGICAL_W / 2;
  let y = LOGICAL_H - M;

  // ---- Header: logo + store name centered, QR top-right --------------------
  const qrImage = order.storeUrl ? await embedQrCode(pdfDoc, order.storeUrl) : null;
  const qrSize = 34;
  const headerTop = y;

  const logoImage = await embedLogo(pdfDoc);
  const logoSize = 40;
  if (logoImage) {
    const scaled = logoImage.scaleToFit(logoSize, logoSize);
    page.drawImage(logoImage, {
      x: centerLineX - scaled.width / 2,
      y: headerTop - scaled.height,
      width: scaled.width,
      height: scaled.height,
    });
  }
  const storeNameSize = logoImage ? 10 : 14;
  const storeNameY = logoImage ? headerTop - logoSize - 11 : headerTop - 12;
  page.drawText(order.storeName, {
    x: centerX(fontBold, order.storeName, storeNameSize, centerLineX),
    y: storeNameY,
    size: storeNameSize,
    font: fontBold,
    color: black,
  });

  if (qrImage) {
    page.drawImage(qrImage, { x: LOGICAL_W - M - qrSize, y: headerTop - qrSize, width: qrSize, height: qrSize });
    const caption = 'Visit Our Store';
    page.drawText(caption, {
      x: rightX(font, caption, 5.5, LOGICAL_W - M),
      y: headerTop - qrSize - 8,
      size: 5.5,
      font,
      color: gray,
    });
  }

  y = Math.min(storeNameY, headerTop - qrSize - 8) - 8;

  page.drawLine({ start: { x: M, y }, end: { x: LOGICAL_W - M, y }, thickness: 1, color: accent });
  y -= 12;

  // ---- Order meta (left) + Ship To box (right) ------------------------------
  const colGutter = 8;
  const rightColW = 138;
  const rightColX = LOGICAL_W - M - rightColW;
  const metaTop = y;

  const dateStr = order.saleDate
    ? new Date(order.saleDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : null;

  const metaRows: [string, string | null][] = [
    ['ORDER #', order.orderNumber],
    ['DATE SOLD', dateStr],
    ['BUYER', order.buyer ?? null],
    ['SALES RECORD #', order.salesRecordNumber],
  ];

  let leftY = metaTop;
  for (const [label, value] of metaRows) {
    if (!value) continue;
    page.drawText(label, { x: M, y: leftY, size: 6, font, color: gray });
    leftY -= 9.5;
    page.drawText(value, { x: M, y: leftY, size: 9, font: fontBold, color: black });
    leftY -= 12.5;
  }

  // Ship-to box
  const shipToLines = [
    order.shipTo.name,
    order.shipTo.street1,
    order.shipTo.street2,
    [order.shipTo.city, order.shipTo.state, order.shipTo.zip].filter(Boolean).join(', '),
    order.shipTo.country,
  ].filter((l): l is string => !!l && l.trim().length > 0);

  const boxPad = 6;
  const boxLineHeight = 10.5;
  const boxHeight = boxPad * 2 + 9 + shipToLines.length * boxLineHeight;
  const boxTop = metaTop;
  const boxBottom = boxTop - boxHeight;

  page.drawRectangle({
    x: rightColX,
    y: boxBottom,
    width: rightColW,
    height: boxHeight,
    color: boxFill,
  });

  let boxY = boxTop - boxPad - 6;
  page.drawText('SHIP TO', { x: rightColX + boxPad, y: boxY, size: 6.5, font: fontBold, color: accent });
  boxY -= 12;
  for (const line of shipToLines) {
    page.drawText(line, { x: rightColX + boxPad, y: boxY, size: 8.5, font: fontBold, color: black });
    boxY -= boxLineHeight;
  }

  y = Math.min(leftY, boxBottom) - 6;

  page.drawLine({ start: { x: M, y }, end: { x: LOGICAL_W - M, y }, thickness: 0.75, color: lightGray });
  y -= 12;

  // ---- Items ----------------------------------------------------------------
  const imgSize = 32;
  const totalColRight = LOGICAL_W - M;
  const priceColRight = totalColRight - 40;
  const qtyColRight = priceColRight - 32;
  const textX = M + imgSize + 6;
  const textWidth = qtyColRight - 24 - textX;

  page.drawText('ITEM', { x: M, y, size: 7, font: fontBold, color: accent });
  page.drawText('Qty', { x: rightX(font, 'Qty', 6, qtyColRight), y, size: 6, font, color: gray });
  page.drawText('Price', { x: rightX(font, 'Price', 6, priceColRight), y, size: 6, font, color: gray });
  page.drawText('Total', { x: rightX(font, 'Total', 6, totalColRight), y, size: 6, font, color: gray });
  y -= 9;
  page.drawLine({ start: { x: M, y }, end: { x: LOGICAL_W - M, y }, thickness: 0.75, color: lightGray });
  y -= 9;

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

    const unitPrice = item.quantity > 0 ? item.soldFor / item.quantity : item.soldFor;
    const qtyStr = String(item.quantity);
    const priceStr = fmt$(unitPrice);
    const totalStr = fmt$(item.soldFor);
    page.drawText(qtyStr, { x: rightX(font, qtyStr, 7.5, qtyColRight), y: rowTop - 8, size: 7.5, font, color: black });
    page.drawText(priceStr, { x: rightX(font, priceStr, 7.5, priceColRight), y: rowTop - 8, size: 7.5, font, color: black });
    page.drawText(totalStr, { x: rightX(fontBold, totalStr, 7.5, totalColRight), y: rowTop - 8, size: 7.5, font: fontBold, color: black });

    y = rowTop - imgSize - 5;
  }

  page.drawLine({ start: { x: M, y }, end: { x: LOGICAL_W - M, y }, thickness: 0.75, color: lightGray });
  y -= 10;

  // ---- Shipping service -------------------------------------------------------
  if (order.shippingService) {
    page.drawText(`Ship via: ${order.shippingService}`, { x: M, y, size: 7, font, color: gray });
    y -= 11;
  }

  // ---- Totals -----------------------------------------------------------------
  const totalsLabelRight = totalColRight - 46;
  const totalsRows: [string, number | null][] = [
    ['Subtotal', order.subtotal],
    ['Shipping', order.shippingCost],
    ['Tax', order.tax],
  ];
  for (const [label, val] of totalsRows) {
    if (val === null) continue;
    page.drawText(label, { x: rightX(font, label, 7, totalsLabelRight), y, size: 7, font, color: gray });
    const valStr = fmt$(val);
    page.drawText(valStr, { x: rightX(font, valStr, 7, totalColRight), y, size: 7, font, color: black });
    y -= 9.5;
  }
  if (order.total !== null) {
    y -= 2;
    page.drawLine({ start: { x: totalsLabelRight - 40, y: y + 8 }, end: { x: totalColRight, y: y + 8 }, thickness: 0.75, color: lightGray });
    const label = 'Total';
    page.drawText(label, { x: rightX(fontBold, label, 9, totalsLabelRight), y, size: 9, font: fontBold, color: black });
    const valStr = fmt$(order.total);
    page.drawText(valStr, { x: rightX(fontBold, valStr, 9, totalColRight), y, size: 9, font: fontBold, color: black });
    y -= 11;
  }

  page.pushOperators(popGraphicsState());
}

/**
 * Generates a plain portrait Letter (8.5"x11") PDF with one order's packing
 * slip rotated 90° into the top half. Print at 100% ("Actual size") and cut
 * once across the middle to get an 8.5"x5.5" slip. Pass a second order to
 * fill the bottom half too (e.g. for batch printing two orders per sheet);
 * otherwise it's left blank.
 */
export async function generatePackingSlipPdf(
  order: PackingSlipOrder,
  secondOrder?: PackingSlipOrder | null
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([LETTER_W, LETTER_H]);

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  await drawSlip(page, pdfDoc, order, font, fontBold, HALF_H);
  if (secondOrder) {
    await drawSlip(page, pdfDoc, secondOrder, font, fontBold, 0);
  }

  return pdfDoc.save();
}
