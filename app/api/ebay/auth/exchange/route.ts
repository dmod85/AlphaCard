import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabase-admin';

function isProd() {
  return process.env.EBAY_ENVIRONMENT?.trim() === 'PRODUCTION';
}

function tokenUrl() {
  return isProd()
    ? 'https://api.ebay.com/identity/v1/oauth2/token'
    : 'https://api.sandbox.ebay.com/identity/v1/oauth2/token';
}

export async function POST(request: NextRequest) {
  const { code } = await request.json();

  if (!code || typeof code !== 'string') {
    return NextResponse.json({ error: 'Missing code' }, { status: 400 });
  }

  const appId = process.env.EBAY_APP_ID?.trim();
  const certId = process.env.EBAY_CERT_ID?.trim();
  const ruName = process.env.EBAY_RUNAME?.trim();

  if (!appId || !certId || !ruName) {
    return NextResponse.json(
      { error: 'EBAY_APP_ID, EBAY_CERT_ID, and EBAY_RUNAME must be set in .env.local' },
      { status: 500 }
    );
  }

  const credentials = Buffer.from(`${appId}:${certId}`).toString('base64');

  const ebayRes = await fetch(tokenUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code.trim(),
      redirect_uri: ruName,
    }),
  });

  if (!ebayRes.ok) {
    const text = await ebayRes.text();
    return NextResponse.json(
      { error: `eBay token exchange failed: ${text}` },
      { status: 502 }
    );
  }

  const data = await ebayRes.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();

  const { error: dbErr } = await supabaseAdmin.from('ebay_tokens').upsert({
    id: 'default',
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: expiresAt,
    updated_at: new Date().toISOString(),
  });

  if (dbErr) {
    console.error('[ebay/auth/exchange] Failed to save tokens:', dbErr.message);
    return NextResponse.json({ error: 'Failed to save tokens to database' }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
