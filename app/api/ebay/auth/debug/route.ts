import { NextResponse } from 'next/server';

// Debug endpoint — shows eBay config (no secrets).
export async function GET() {
  const token = process.env.EBAY_OAUTH_TOKEN?.trim().replace(/^'|'$/g, '');
  return NextResponse.json({
    EBAY_APP_ID: process.env.EBAY_APP_ID ? '***set***' : '***MISSING***',
    EBAY_DEV_ID: process.env.EBAY_DEV_ID ? '***set***' : '***MISSING***',
    EBAY_CERT_ID: process.env.EBAY_CERT_ID ? '***set***' : '***MISSING***',
    EBAY_OAUTH_TOKEN: token ? `${token.substring(0, 10)}... (${token.length} chars)` : '***MISSING***',
    EBAY_ENVIRONMENT: process.env.EBAY_ENVIRONMENT || '***MISSING***',
    tokenType: token?.startsWith('v^') ? 'OAuth2 (IAF header)' : 'Auth-n-Auth (XML body)',
  });
}
