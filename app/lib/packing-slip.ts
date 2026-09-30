import 'server-only';
import fs from 'fs';
import path from 'path';
import {
  PDFDocument,
  PDFPage,
  PDFFont,
  PDFImage,
  PDFName,
  StandardFonts,
  rgb,
  degrees,
} from 'pdf-lib';

// Portrait 5x8.5 paper. We set the canvas to exactly 5x8.5 and 
// define a slip width slightly smaller to provide healthy margins.
// We draw the slip on a 5x8.5 canvas, and then embed and rotate it onto
// an 8.5x11 page so the printer can feed it sideways without warnings.
const SLIP_W = 5 * 72; // 360pt
const SLIP_H = 8.5 * 72; // 612pt

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

/** Draws one order upright, 5.25" wide, on the left of a portrait letter page. */
async function drawSlip(
  page: PDFPage,
  pdfDoc: PDFDocument,
  order: PackingSlipOrder,
  font: PDFFont,
  fontBold: PDFFont
) {
  const gray = rgb(0.45, 0.45, 0.45);
  const black = rgb(0.1, 0.1, 0.1);
  const lightGray = rgb(0.82, 0.82, 0.82);
  const boxFill = rgb(0.95, 0.96, 0.97);
  const accent = rgb(0.13, 0.29, 0.72);

  const M = 4;
  const TOP = 4;
  const pageW = SLIP_W;
  const centerLineX = pageW / 2;
  let y = SLIP_H - TOP;

  // ---- Header: logo + store name centered, QR top-right --------------------
  const qrImage = order.storeUrl ? await embedQrCode(pdfDoc, order.storeUrl) : null;
  const qrSize = 40;
  const headerTop = y;

  const logoImage = await embedLogo(pdfDoc);
  const logoSize = 36;
  if (logoImage) {
    const scaled = logoImage.scaleToFit(logoSize, logoSize);
    page.drawImage(logoImage, {
      x: centerLineX - scaled.width / 2,
      y: headerTop - scaled.height,
      width: scaled.width,
      height: scaled.height,
    });
  }
  const storeNameSize = logoImage ? 10 : 13;
  const storeNameY = logoImage ? headerTop - logoSize - 14 : headerTop - 16;
  page.drawText(order.storeName, {
    x: centerX(fontBold, order.storeName, storeNameSize, centerLineX),
    y: storeNameY,
    size: storeNameSize,
    font: fontBold,
    color: black,
  });

  if (qrImage) {
    page.drawImage(qrImage, { x: pageW - M - qrSize, y: headerTop - qrSize, width: qrSize, height: qrSize });
    const caption = 'Visit Our Store';
    page.drawText(caption, {
      x: rightX(font, caption, 8, pageW - M),
      y: headerTop - qrSize - 12,
      size: 8,
      font,
      color: gray,
    });
  }

  y = Math.min(storeNameY, headerTop - qrSize - 12) - 12;

  page.drawLine({ start: { x: M, y }, end: { x: pageW - M, y }, thickness: 1.25, color: accent });
  y -= 18;

  // ---- Order meta (left) + Ship To box (right) ------------------------------
  const rightColW = 148;
  const rightColX = pageW - M - rightColW;
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
    page.drawText(label, { x: M, y: leftY, size: 7, font, color: gray });
    leftY -= 11;
    page.drawText(value, { x: M, y: leftY, size: 9, font: fontBold, color: black });
    leftY -= 13;
  }

  // Ship-to box
  const shipToLines = [
    order.shipTo.name,
    order.shipTo.street1,
    order.shipTo.street2,
    [order.shipTo.city, order.shipTo.state, order.shipTo.zip].filter(Boolean).join(', '),
    order.shipTo.country,
  ].filter((l): l is string => !!l && l.trim().length > 0);

  const boxPad = 8;
  const boxLineHeight = 13;
  const innerW = rightColW - boxPad * 2;
  const wrappedShip = shipToLines.flatMap((line) => wrapText(line, fontBold, 8, innerW).slice(0, 2));
  const boxHeight = boxPad * 2 + 14 + wrappedShip.length * boxLineHeight;
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
  page.drawText('SHIP TO', { x: rightColX + boxPad, y: boxY, size: 8, font: fontBold, color: accent });
  boxY -= 15;
  for (const line of wrappedShip) {
    page.drawText(line, { x: rightColX + boxPad, y: boxY, size: 8, font: fontBold, color: black });
    boxY -= boxLineHeight;
  }

  y = Math.min(leftY, boxBottom) - 10;

  page.drawLine({ start: { x: M, y }, end: { x: pageW - M, y }, thickness: 0.75, color: lightGray });
  y -= 16;

  // ---- Items ----------------------------------------------------------------
  const imgSize = 32;
  const totalColRight = pageW - M;
  const priceColRight = totalColRight - 46;
  const qtyColRight = priceColRight - 28;
  const textX = M + imgSize + 8;
  const textWidth = qtyColRight - 16 - textX;

  page.drawText('ITEM', { x: M, y, size: 9, font: fontBold, color: accent });
  page.drawText('Qty', { x: rightX(font, 'Qty', 8, qtyColRight), y, size: 8, font, color: gray });
  page.drawText('Price', { x: rightX(font, 'Price', 8, priceColRight), y, size: 8, font, color: gray });
  page.drawText('Total', { x: rightX(font, 'Total', 8, totalColRight), y, size: 8, font, color: gray });
  y -= 12;
  page.drawLine({ start: { x: M, y }, end: { x: pageW - M, y }, thickness: 0.75, color: lightGray });
  y -= 12;

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

    const titleLines = wrapText(item.title, font, 10, textWidth).slice(0, 2);
    let ty = rowTop - 11;
    for (const line of titleLines) {
      page.drawText(line, { x: textX, y: ty, size: 10, font, color: black });
      ty -= 13;
    }
    const skuLabel = item.sku ? `SKU: ${item.sku}` : item.ebayItemId ? `Item: ${item.ebayItemId}` : '';
    if (skuLabel) {
      page.drawText(skuLabel, { x: textX, y: rowTop - imgSize + 4, size: 8, font, color: gray });
    }

    const unitPrice = item.quantity > 0 ? item.soldFor / item.quantity : item.soldFor;
    const qtyStr = String(item.quantity);
    const priceStr = fmt$(unitPrice);
    const totalStr = fmt$(item.soldFor);
    page.drawText(qtyStr, { x: rightX(font, qtyStr, 10, qtyColRight), y: rowTop - 11, size: 10, font, color: black });
    page.drawText(priceStr, { x: rightX(font, priceStr, 10, priceColRight), y: rowTop - 11, size: 10, font, color: black });
    page.drawText(totalStr, { x: rightX(fontBold, totalStr, 10, totalColRight), y: rowTop - 11, size: 10, font: fontBold, color: black });

    y = rowTop - imgSize - 8;
  }

  page.drawLine({ start: { x: M, y }, end: { x: pageW - M, y }, thickness: 0.75, color: lightGray });
  y -= 16;

  // ---- Shipping service -------------------------------------------------------
  if (order.shippingService) {
    page.drawText(`Ship via: ${order.shippingService}`, { x: M, y, size: 10, font, color: gray });
    y -= 16;
  }

  // ---- Totals -----------------------------------------------------------------
  const totalsLabelRight = totalColRight - 64;
  const totalsRows: [string, number | null][] = [
    ['Subtotal', order.subtotal],
    ['Shipping', order.shippingCost],
    ['Tax', order.tax],
  ];
  for (const [label, val] of totalsRows) {
    if (val === null) continue;
    page.drawText(label, { x: rightX(font, label, 10, totalsLabelRight), y, size: 10, font, color: gray });
    const valStr = fmt$(val);
    page.drawText(valStr, { x: rightX(font, valStr, 10, totalColRight), y, size: 10, font, color: black });
    y -= 14;
  }
  if (order.total !== null) {
    y -= 2;
    page.drawLine({ start: { x: totalsLabelRight - 48, y: y + 12 }, end: { x: totalColRight, y: y + 12 }, thickness: 0.75, color: lightGray });
    const label = 'Total';
    page.drawText(label, { x: rightX(fontBold, label, 13, totalsLabelRight), y, size: 13, font: fontBold, color: black });
    const valStr = fmt$(order.total);
    page.drawText(valStr, { x: rightX(fontBold, valStr, 13, totalColRight), y, size: 13, font: fontBold, color: black });
  }
}

/**
 * Portrait letter packing slip at actual size. Content is 5.25" wide on the left.
 * A second order is placed on its own page.
 */
export async function generatePackingSlipPdf(
  order: PackingSlipOrder,
  secondOrder?: PackingSlipOrder | null
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.catalog.set(
    PDFName.of('ViewerPreferences'),
    pdfDoc.context.obj({ PrintScaling: PDFName.of('None') })
  );

  const createRotatedPage = async (ord: PackingSlipOrder) => {
    // 1. Create a 5x8.5 document
    const tempDoc = await PDFDocument.create();
    const tFont = await tempDoc.embedFont(StandardFonts.Helvetica);
    const tFontBold = await tempDoc.embedFont(StandardFonts.HelveticaBold);
    const tempPage = tempDoc.addPage([SLIP_W, SLIP_H]);
    await drawSlip(tempPage, tempDoc, ord, tFont, tFontBold);
    
    // 2. Embed the 5x8.5 slip into our final 8.5x11 document
    const [embeddedSlip] = await pdfDoc.embedPdf(await tempDoc.save());
    
    // 3. Create the final 8.5x11 Letter page
    const LETTER_W = 8.5 * 72;
    const LETTER_H = 11 * 72;
    const page = pdfDoc.addPage([LETTER_W, LETTER_H]);
    
    // 4. Draw the embedded slip rotated 90 degrees CCW
    // This perfectly places the 5" width along the 11" height edge, and 
    // the 8.5" height along the 8.5" width edge, fitting neatly into the top 5" 
    // of the 8.5x11 Letter page!
    page.drawPage(embeddedSlip, {
      x: 8.5 * 72,
      y: 6 * 72,
      xScale: 1,
      yScale: 1,
      rotate: degrees(90),
    });
  };

  await createRotatedPage(order);
  if (secondOrder) {
    await createRotatedPage(secondOrder);
  }

  return pdfDoc.save();
}
