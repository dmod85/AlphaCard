import { NextRequest, NextResponse } from 'next/server';
import { getValidToken, getEbayApiHeaders, getEbayApiUrl } from '@/app/lib/ebay-auth';

export async function GET(request: NextRequest) {
  try {
    const token = await getValidToken();
    const xmlBody = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
  <ActiveList>
    <Include>true</Include>
    <Pagination>
      <EntriesPerPage>1</EntriesPerPage>
      <PageNumber>1</PageNumber>
    </Pagination>
  </ActiveList>
  <DetailLevel>ReturnAll</DetailLevel>
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
</GetMyeBaySellingRequest>`;
    const response = await fetch(getEbayApiUrl(), {
      method: 'POST',
      headers: getEbayApiHeaders('GetMyeBaySelling', token),
      body: xmlBody,
    });
    const text = await response.text();
    return new NextResponse(text, { headers: { 'Content-Type': 'text/xml' } });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
