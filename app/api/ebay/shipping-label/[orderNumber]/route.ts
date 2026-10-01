import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const runtime = 'nodejs';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orderNumber: string }> }
) {
  const { orderNumber } = await params;

  const repoRoot = process.cwd();
  const savedDir = path.join(repoRoot, 'labels', 'saved');
  const filePath = path.join(savedDir, `${orderNumber}.pdf`);

  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ error: `No shipping label found for order ${orderNumber}` }, { status: 404 });
  }

  const pdfBytes = fs.readFileSync(filePath);

  return new NextResponse(pdfBytes, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="shipping-label-${orderNumber}.pdf"`,
    },
  });
}
