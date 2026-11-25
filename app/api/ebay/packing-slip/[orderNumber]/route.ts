import { NextRequest, NextResponse } from 'next/server';
import { regenerateAndStoreSlip } from '@/app/lib/packing-slip-store';
import { slipContentDisposition } from '@/app/lib/slip-disposition';

// Manual/on-demand packing slip generation — GET /api/ebay/packing-slip/{orderNumber}
// Rebuilds the slip with the current layout, overwrites the stored PDF, and
// returns the fresh bytes (view or save). Useful for testing the layout or
// re-printing without waiting for a real eBay event.

export const runtime = 'nodejs';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orderNumber: string }> }
) {
  const { orderNumber } = await params;
  const download = request.nextUrl.searchParams.get('download') === '1';

  let result: Awaited<ReturnType<typeof regenerateAndStoreSlip>>;
  try {
    result = await regenerateAndStoreSlip(orderNumber);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to generate packing slip' }, { status: 500 });
  }
  if (!result) {
    return NextResponse.json({ error: `No sales found for order ${orderNumber}` }, { status: 404 });
  }

  return new NextResponse(Buffer.from(result.bytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': slipContentDisposition(orderNumber, download),
    },
  });
}
