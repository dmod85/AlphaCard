import { NextResponse } from 'next/server';
import { getAuthorizationUrl } from '@/app/lib/ebay-auth';

// Redirects the browser to eBay's OAuth consent page.
// After the seller authorizes, eBay sends them back to /api/ebay/auth/callback.
export async function GET() {
  const url = getAuthorizationUrl();
  console.log('[ebay-auth] EBAY_ENVIRONMENT:', process.env.EBAY_ENVIRONMENT);
  console.log('[ebay-auth] Redirecting to:', url.substring(0, 80));
  return NextResponse.redirect(url);
}
