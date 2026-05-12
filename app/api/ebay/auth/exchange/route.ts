import { NextRequest, NextResponse } from 'next/server';
import { exchangeCodeForTokens, saveTokens } from '@/app/lib/ebay-auth';

export async function POST(request: NextRequest) {
  try {
    const { code } = await request.json();
    if (!code) return NextResponse.json({ error: 'No code provided' }, { status: 400 });

    const tokens = await exchangeCodeForTokens(code.trim());
    await saveTokens(tokens.access_token, tokens.refresh_token, tokens.expires_in);
    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Token exchange failed' }, { status: 500 });
  }
}
