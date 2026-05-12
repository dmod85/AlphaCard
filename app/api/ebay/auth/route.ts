import { NextResponse } from 'next/server';
import { getAuthorizationUrl } from '@/app/lib/ebay-auth';

// Redirects the browser to eBay's OAuth consent page.
// After the seller authorizes, eBay sends them back to /api/ebay/auth/callback.
export async function GET() {
  const url = getAuthorizationUrl();
  console.log('[ebay-auth] Redirecting to:', url);
  // Use a manual 302 to avoid Next.js re-encoding the Location header
  return new Response(null, {
    status: 302,
    headers: { Location: url },
  });
}
