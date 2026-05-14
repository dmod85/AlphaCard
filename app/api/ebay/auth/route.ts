import { NextResponse } from 'next/server';

// OAuth2 authorization flow has been removed.
// eBay auth is now handled via the EBAY_OAUTH_TOKEN env var
// passed through the X-EBAY-API-IAF-TOKEN header.
export async function GET() {
  return NextResponse.json({
    message: 'OAuth2 flow disabled. Set EBAY_OAUTH_TOKEN in .env instead.',
  });
}
