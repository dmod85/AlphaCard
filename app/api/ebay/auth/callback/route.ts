import { NextRequest, NextResponse } from 'next/server';

// OAuth2 callback flow has been removed.
// eBay auth is now handled via the EBAY_OAUTH_TOKEN env var.
export async function GET(request: NextRequest) {
  const base = new URL(request.url).origin;
  return NextResponse.redirect(`${base}/active-listings?ebay_error=oauth_flow_disabled`);
}
