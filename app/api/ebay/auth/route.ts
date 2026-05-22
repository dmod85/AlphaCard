import { NextResponse } from 'next/server';

const EBAY_SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
  'https://api.ebay.com/oauth/api_scope/sell.marketing',
].join(' ');

export async function GET() {
  const isProd = process.env.EBAY_ENVIRONMENT?.trim() === 'PRODUCTION';
  const authBase = isProd
    ? 'https://auth.ebay.com/oauth2/authorize'
    : 'https://auth.sandbox.ebay.com/oauth2/authorize';

  const ruName = process.env.EBAY_RUNAME?.trim();
  const appId = process.env.EBAY_APP_ID?.trim();

  if (!ruName || !appId) {
    return NextResponse.json(
      { error: 'EBAY_APP_ID and EBAY_RUNAME must be set in .env.local' },
      { status: 500 }
    );
  }

  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: ruName,
    response_type: 'code',
    scope: EBAY_SCOPES,
  });

  return NextResponse.redirect(`${authBase}?${params.toString()}`);
}
