import { NextRequest, NextResponse } from 'next/server';
import { exchangeCodeForTokens, saveTokens } from '@/app/lib/ebay-auth';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const error = searchParams.get('error');

  const base = new URL(request.url).origin;

  if (error || !code) {
    const msg = error || 'no_code';
    return NextResponse.redirect(`${base}/active-listings?ebay_error=${encodeURIComponent(msg)}`);
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    await saveTokens(tokens.access_token, tokens.refresh_token, tokens.expires_in);
    return NextResponse.redirect(`${base}/active-listings?ebay_connected=1`);
  } catch (err: any) {
    return NextResponse.redirect(
      `${base}/active-listings?ebay_error=${encodeURIComponent(err.message)}`
    );
  }
}
