import { NextRequest, NextResponse } from 'next/server';
import { getValidToken, isOAuthToken, getEbayApiHeaders, getEbayApiUrl, clearTokenCache } from '@/app/lib/ebay-auth';
import { supabaseAdmin } from '@/app/lib/supabase-admin';

interface NameValuePair {
  name: string;
  value: string;
}

interface ReviseItem {
  itemId: string;
  specifics: NameValuePair[];
  title?: string;
  description?: string;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function decodeXml(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function buildReviseSpecificsRequest(item: ReviseItem, token: string): string {
  const credentials = isOAuthToken(token)
    ? ''
    : `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>`;

  const titleXml = item.title
    ? `<Title>${escapeXml(item.title.trim())}</Title>`
    : '';

  const descriptionXml = item.description
    ? `<Description><![CDATA[${item.description.trim()}]]></Description>`
    : '';

  const specificsXml = item.specifics
    .filter((s) => s.name.trim() && s.value.trim())
    .map(
      (s) =>
        `<NameValueList><Name>${escapeXml(s.name)}</Name><Value>${escapeXml(s.value)}</Value></NameValueList>`
    )
    .join('\n      ');

  const itemSpecificsXml = specificsXml
    ? `<ItemSpecifics>\n      ${specificsXml}\n    </ItemSpecifics>`
    : '';

  return `<?xml version="1.0" encoding="utf-8"?>
<ReviseItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  ${credentials}
  <Item>
    <ItemID>${item.itemId}</ItemID>
    ${titleXml}
    ${descriptionXml}
    ${itemSpecificsXml}
  </Item>
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
</ReviseItemRequest>`;
}

/**
 * POST /api/ebay/revise-specifics
 * Body: { items: [{ itemId, specifics: NameValuePair[] }] }
 * Revises item specifics for each item via eBay ReviseItem Trading API call.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { items: ReviseItem[] };

    if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
      return NextResponse.json({ error: 'No items provided' }, { status: 400 });
    }

    const token = await getValidToken();

    const results = await Promise.all(
      body.items.map(async (item) => {
        try {
          const xml = buildReviseSpecificsRequest(item, token);
          const res = await fetch(getEbayApiUrl(), {
            method: 'POST',
            headers: getEbayApiHeaders('ReviseItem', token),
            body: xml,
          });
          const text = await res.text();

          const ack = text.match(/<Ack>(.*?)<\/Ack>/)?.[1];
          if (ack === 'Success' || ack === 'Warning') {
            // Keep the specifics cache in sync with what eBay now has, so the
            // Listing Details page doesn't need a fresh GetItem call to see it.
            await supabaseAdmin
              .from('ebay_item_specifics')
              .upsert(
                { item_id: item.itemId, specifics: item.specifics, updated_at: new Date().toISOString() },
                { onConflict: 'item_id' }
              );
            return { itemId: item.itemId, success: true };
          }

          const errorMsg =
            text.match(/<LongMessage>(.*?)<\/LongMessage>/)?.[1] ||
            text.match(/<ShortMessage>(.*?)<\/ShortMessage>/)?.[1] ||
            'Unknown eBay error';
          return { itemId: item.itemId, success: false, error: decodeXml(errorMsg) };
        } catch (err: any) {
          return { itemId: item.itemId, success: false, error: err.message || 'Network error' };
        }
      })
    );

    return NextResponse.json({ results });
  } catch (err: any) {
    if (err.message === 'EBAY_AUTH_REQUIRED') {
      clearTokenCache();
      return NextResponse.json({ error: 'EBAY_AUTH_REQUIRED' }, { status: 401 });
    }
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}
