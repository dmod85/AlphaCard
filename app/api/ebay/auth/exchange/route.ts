import { NextRequest, NextResponse } from 'next/server';

// OAuth2 code exchange has been removed.
// eBay auth is now handled via the EBAY_OAUTH_TOKEN env var.
export async function POST(request: NextRequest) {
  return NextResponse.json(
    { error: 'OAuth2 flow disabled. Set EBAY_OAUTH_TOKEN in .env instead.' },
    { status: 410 }
  );
}
