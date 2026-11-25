import { NextRequest, NextResponse } from 'next/server';
import {
  regenerateAndStoreSlip,
  shouldUpdateRowsOnView,
} from '@/app/lib/packing-slip-store';
import { slipContentDisposition } from '@/app/lib/slip-disposition';

// Manual/on-demand packing slip generation — GET /api/ebay/packing-slip/{orderNumber}
// Rebuilds the slip with the current layout, overwrites the stored PDF, and
// returns the fresh bytes (view or save). Row URLs are only updated when the
// order is already printed, so viewing an unprinted slip cannot auto-print it.

export const runtime = 'nodejs';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orderNumber: string }> }
) {
  const { orderNumber } = await params;
  const download = request.nextUrl.searchParams.get('download') === '1';

  let result: Awaited<ReturnType<typeof regenerateAndStoreSlip>>;
  try {
    result = await regenerateAndStoreSlip(orderNumber, {
      updateRows: ({ alreadyPrinted }) => shouldUpdateRowsOnView(alreadyPrinted),
      throwOnStoreError: false,
    });
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
