import { NextResponse } from 'next/server';
import { getAuthorizationUrl } from '@/app/lib/ebay-auth';

export async function GET() {
  return NextResponse.json({
    EBAY_APP_ID: JSON.stringify(process.env.EBAY_APP_ID),
    EBAY_REDIRECT_URI: JSON.stringify(process.env.EBAY_REDIRECT_URI),
    EBAY_ENVIRONMENT: JSON.stringify(process.env.EBAY_ENVIRONMENT),
    authUrl: getAuthorizationUrl(),
  });
}
