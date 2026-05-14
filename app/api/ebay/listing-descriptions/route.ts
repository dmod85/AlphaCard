import { NextRequest, NextResponse } from 'next/server';
import { getValidToken, isOAuthToken, getEbayApiHeaders, getEbayApiUrl } from '@/app/lib/ebay-auth';

async function fetchDescription(itemId: string, token: string): Promise<string> {
  const credentials = isOAuthToken(token)
    ? ''
    : `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>`;

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  ${credentials}
  <ItemID>${itemId}</ItemID>
  <OutputSelector>Description</OutputSelector>
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
</GetItemRequest>`;

  const res = await fetch(getEbayApiUrl(), {
    method: 'POST',
    headers: getEbayApiHeaders('GetItem', token),
    body: xml,
  });

  const text = await res.text();

  // Description may be in CDATA or plain text
  const raw =
    text.match(/<Description><!\[CDATA\[([\s\S]*?)\]\]><\/Description>/)?.[1] ??
    text.match(/<Description>([\s\S]*?)<\/Description>/)?.[1] ??
    text.match(/<TextDescription>([\s\S]*?)<\/TextDescription>/)?.[1] ??
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
