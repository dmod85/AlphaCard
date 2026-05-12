import { NextRequest, NextResponse } from 'next/server';
import { getValidToken } from '@/app/lib/ebay-auth';

const EBAY_API_URL = process.env.EBAY_ENVIRONMENT === 'PRODUCTION'
  ? 'https://api.ebay.com/ws/api.dll'
  : 'https://api.sandbox.ebay.com/ws/api.dll';

const EBAY_APP_ID = process.env.EBAY_APP_ID!;
const EBAY_DEV_ID = process.env.EBAY_DEV_ID!;
const EBAY_CERT_ID = process.env.EBAY_CERT_ID!;

async function fetchDescription(itemId: string, token: string): Promise<string> {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${token}</eBayAuthToken>
  </RequesterCredentials>
  <ItemID>${itemId}</ItemID>
  <OutputSelector>Description</OutputSelector>
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
</GetItemRequest>`;

  const res = await fetch(EBAY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml',
      'X-EBAY-API-COMPATIBILITY-LEVEL': '1349',
      'X-EBAY-API-DEV-NAME': EBAY_DEV_ID,
      'X-EBAY-API-APP-NAME': EBAY_APP_ID,
      'X-EBAY-API-CERT-NAME': EBAY_CERT_ID,
      'X-EBAY-API-CALL-NAME': 'GetItem',
      'X-EBAY-API-SITEID': '0',
    },
    body: xml,
  });

  const text = await res.text();

  // Description may be in CDATA or plain text
  const raw =
    text.match(/<Description><!\[CDATA\[([\s\S]*?)\]\]><\/Description>/)?.[1] ??
    text.match(/<Description>([\s\S]*?)<\/Description>/)?.[1] ??
    '';

  // Strip HTML tags and collapse whitespace to a plain-text snippet
  return raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

export async function POST(request: NextRequest) {
  try {
    const { itemIds } = await request.json() as { itemIds: string[] };
    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      return NextResponse.json({ descriptions: {} });
    }

    const token = await getValidToken();

    const results = await Promise.allSettled(
      itemIds.map(id => fetchDescription(id, token).then(desc => ({ id, desc })))
    );

    const descriptions: Record<string, string> = {};
    for (const r of results) {
      if (r.status === 'fulfilled') descriptions[r.value.id] = r.value.desc;
    }

    return NextResponse.json({ descriptions });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
