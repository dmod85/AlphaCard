import { NextResponse } from 'next/server';
import { getAuthorizationUrl } from '@/app/lib/ebay-auth';

// Redirects the browser to eBay's OAuth consent page.
// After the seller authorizes, eBay sends them back to /api/ebay/auth/callback.
export async function GET() {
  return NextResponse.redirect(getAuthorizationUrl());
}
