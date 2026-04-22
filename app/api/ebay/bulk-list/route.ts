import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabase';

// eBay Trading API config
const EBAY_API_URL = process.env.EBAY_ENVIRONMENT === 'PRODUCTION'
  ? 'https://api.ebay.com/ws/api.dll'
  : 'https://api.sandbox.ebay.com/ws/api.dll';

const EBAY_APP_ID = process.env.EBAY_APP_ID!;
const EBAY_DEV_ID = process.env.EBAY_DEV_ID!;
const EBAY_CERT_ID = process.env.EBAY_CERT_ID!;

// Category IDs for trading cards
const CATEGORY_MAP: Record<string, string> = {
  nfl: '261328',  // Sports Trading Card Singles
  nba: '261328',
  mlb: '261328',
  nhl: '261328',
  soccer: '261328',
  other: '183050', // Non-Sport Trading Card Singles
};

// Condition IDs
const CONDITION_GRADED = '2750';
const CONDITION_UNGRADED = '4000';

function getOAuthToken(): string {
  const token = process.env.EBAY_OAUTH_TOKEN || '';
  // Strip surrounding quotes if present
  return token.replace(/^['"]|['"]$/g, '');
}

function buildItemXml(item: any): string {
  const categoryId = CATEGORY_MAP[item.sport] || CATEGORY_MAP.other;
  const conditionId = item.condition === 'graded' ? CONDITION_GRADED : CONDITION_UNGRADED;

  // Build title: combine fields or use provided title
  const title = item.title || [
    item.card_year,
    item.card_set,
    item.player_name,
    item.card_number ? `#${item.card_number}` : '',
    item.parallel_type,
    item.condition === 'graded' && item.grader ? `${item.grader} ${item.grade}` : '',
  ].filter(Boolean).join(' ').slice(0, 80);

  // Build condition descriptors
  let conditionDescriptors = '';
  if (item.condition === 'graded') {
    conditionDescriptors = `
      <ConditionDescriptors>
        ${item.grader ? `<ConditionDescriptor><Name>Professional Grader</Name><Value>${escapeXml(item.grader)}</Value></ConditionDescriptor>` : ''}
        ${item.grade ? `<ConditionDescriptor><Name>Grade</Name><Value>${escapeXml(item.grade)}</Value></ConditionDescriptor>` : ''}
        ${item.cert_number ? `<ConditionDescriptor><Name>Certification Number</Name><AdditionalInfo>${escapeXml(item.cert_number)}</AdditionalInfo></ConditionDescriptor>` : ''}
      </ConditionDescriptors>`;
  } else {
    conditionDescriptors = `
      <ConditionDescriptors>
        <ConditionDescriptor><Name>Card Condition</Name><Value>Near Mint or Better</Value></ConditionDescriptor>
      </ConditionDescriptors>`;
  }

  // Build item specifics
  const specifics: { name: string; value: string }[] = [];
  if (item.sport) specifics.push({ name: 'Sport', value: item.sport.toUpperCase() });
  if (item.player_name) specifics.push({ name: 'Player/Athlete', value: item.player_name });
  if (item.card_year) specifics.push({ name: 'Year Manufactured', value: String(item.card_year) });
  if (item.card_set) specifics.push({ name: 'Set', value: item.card_set });
  if (item.card_number) specifics.push({ name: 'Card Number', value: item.card_number });

  const itemSpecificsXml = specifics.length > 0 ? `
    <ItemSpecifics>
      ${specifics.map(s => `<NameValueList><Name>${escapeXml(s.name)}</Name><Value>${escapeXml(s.value)}</Value></NameValueList>`).join('\n      ')}
    </ItemSpecifics>` : '';

  // Build picture URLs
  const pictureXml = item.image_urls && item.image_urls.length > 0
    ? `<PictureDetails>${item.image_urls.map((url: string) => `<PictureURL>${escapeXml(url)}</PictureURL>`).join('')}</PictureDetails>`
    : '';

  return `
    <Item>
      <Title>${escapeXml(title)}</Title>
      <PrimaryCategory><CategoryID>${categoryId}</CategoryID></PrimaryCategory>
      <ConditionID>${conditionId}</ConditionID>
      ${conditionDescriptors}
      <StartPrice>${item.price.toFixed(2)}</StartPrice>
      <Quantity>${item.quantity || 1}</Quantity>
      <ListingType>FixedPriceItem</ListingType>
      <ListingDuration>GTC</ListingDuration>
      <BestOfferDetails><BestOfferEnabled>true</BestOfferEnabled></BestOfferDetails>
      <Country>US</Country>
      <Currency>USD</Currency>
      <DispatchTimeMax>3</DispatchTimeMax>
      <ShippingDetails>
        <ShippingType>Flat</ShippingType>
        <ShippingServiceOptions>
          <ShippingServicePriority>1</ShippingServicePriority>
          <ShippingService>USPSMedia</ShippingService>
          <ShippingServiceCost>0.00</ShippingServiceCost>
          <FreeShipping>true</FreeShipping>
        </ShippingServiceOptions>
      </ShippingDetails>
      <ReturnPolicy>
        <ReturnsAcceptedOption>ReturnsNotAccepted</ReturnsAcceptedOption>
      </ReturnPolicy>
      ${itemSpecificsXml}
      ${pictureXml}
    </Item>`;
}

function escapeXml(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildAddItemsRequest(items: any[]): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<AddItemsRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${getOAuthToken()}</eBayAuthToken>
  </RequesterCredentials>
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  ${items.map(item => `<AddItemRequestContainer>
    <MessageID>${item.id}</MessageID>
    ${buildItemXml(item)}
  </AddItemRequestContainer>`).join('\n')}
</AddItemsRequest>`;
}

async function callEbayApi(xmlBody: string): Promise<string> {
  const response = await fetch(EBAY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml',
      'X-EBAY-API-COMPATIBILITY-LEVEL': '1349',
      'X-EBAY-API-DEV-NAME': EBAY_DEV_ID,
      'X-EBAY-API-APP-NAME': EBAY_APP_ID,
      'X-EBAY-API-CERT-NAME': EBAY_CERT_ID,
      'X-EBAY-API-CALL-NAME': 'AddItems',
      'X-EBAY-API-SITEID': '0',
    },
    body: xmlBody,
  });
  return response.text();
}

function parseAddItemsResponse(xml: string): Array<{
  messageId: string;
  success: boolean;
  itemId?: string;
  error?: string;
}> {
  const results: Array<{ messageId: string; success: boolean; itemId?: string; error?: string }> = [];

  // Parse each AddItemResponseContainer
  const containerRegex = /<AddItemResponseContainer>([\s\S]*?)<\/AddItemResponseContainer>/g;
  let match;

  while ((match = containerRegex.exec(xml)) !== null) {
    const container = match[1];

    const messageIdMatch = container.match(/<CorrelationID>(.*?)<\/CorrelationID>/);
    const messageId = messageIdMatch?.[1] || '';

    const ackMatch = container.match(/<Ack>(.*?)<\/Ack>/);
    const ack = ackMatch?.[1] || '';

    const itemIdMatch = container.match(/<ItemID>(.*?)<\/ItemID>/);
    const itemId = itemIdMatch?.[1];

    const errorMatch = container.match(/<ShortMessage>(.*?)<\/ShortMessage>/);
    const errorMsg = errorMatch?.[1];

    const longErrorMatch = container.match(/<LongMessage>(.*?)<\/LongMessage>/);

    results.push({
      messageId,
      success: ack === 'Success' || ack === 'Warning',
      itemId,
      error: ack === 'Failure' ? (longErrorMatch?.[1] || errorMsg || 'Unknown eBay error') : undefined,
    });
  }

  // If no containers found, check for a top-level error
  if (results.length === 0) {
    const topError = xml.match(/<ShortMessage>(.*?)<\/ShortMessage>/);
    const topLong = xml.match(/<LongMessage>(.*?)<\/LongMessage>/);
    if (topError) {
      results.push({
        messageId: 'all',
        success: false,
        error: topLong?.[1] || topError[1] || 'eBay API error',
      });
    }
  }

  return results;
}

// ============================================================================
// POST — Submit a bulk listing batch
// ============================================================================
export async function POST(request: NextRequest) {
  try {
    const { items } = await request.json();

    if (!items || !Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: 'No items provided' }, { status: 400 });
    }

    // Create the job
    const { data: job, error: jobError } = await supabaseAdmin
      .from('ebay_listing_jobs')
      .insert({ total_items: items.length, status: 'processing' })
      .select()
      .single();

    if (jobError || !job) {
      return NextResponse.json({ error: jobError?.message || 'Failed to create job' }, { status: 500 });
    }

    // Insert all items
    const itemRows = items.map((item: any) => ({
      job_id: job.id,
      title: item.title || `${item.card_year || ''} ${item.card_set || ''} ${item.player_name || ''} #${item.card_number || ''}`.trim(),
      player_name: item.player_name || null,
      card_year: item.card_year ? parseInt(item.card_year) : null,
      card_set: item.card_set || null,
      card_number: item.card_number || null,
      sport: item.sport || 'mlb',
      condition: item.condition || 'ungraded',
      grader: item.grader || null,
      grade: item.grade || null,
      cert_number: item.cert_number || null,
      price: parseFloat(item.price),
      quantity: parseInt(item.quantity) || 1,
      image_urls: item.image_urls || null,
      status: 'pending',
    }));

    const { data: insertedItems, error: insertError } = await supabaseAdmin
      .from('ebay_listing_items')
      .insert(itemRows)
      .select();

    if (insertError || !insertedItems) {
      return NextResponse.json({ error: insertError?.message || 'Failed to insert items' }, { status: 500 });
    }

    // Process in batches of 5 (eBay AddItems limit)
    let listedCount = 0;
    let failedCount = 0;

    for (let i = 0; i < insertedItems.length; i += 5) {
      const batch = insertedItems.slice(i, i + 5);

      try {
        const xmlRequest = buildAddItemsRequest(batch);
        const xmlResponse = await callEbayApi(xmlRequest);
        const results = parseAddItemsResponse(xmlResponse);

        // Handle top-level error
        if (results.length === 1 && results[0].messageId === 'all' && !results[0].success) {
          // All items in this batch failed
          for (const item of batch) {
            await supabaseAdmin.from('ebay_listing_items').update({
              status: 'failed',
              error_message: results[0].error || 'eBay API error',
            }).eq('id', item.id);
            failedCount++;
          }
          continue;
        }

        // Map results back to items
        for (const item of batch) {
          const result = results.find(r => r.messageId === item.id);

          if (result?.success && result.itemId) {
            await supabaseAdmin.from('ebay_listing_items').update({
              status: 'listed',
              ebay_item_id: result.itemId,
              ebay_listing_url: `https://www.ebay.com/itm/${result.itemId}`,
            }).eq('id', item.id);
            listedCount++;
          } else {
            await supabaseAdmin.from('ebay_listing_items').update({
              status: 'failed',
              error_message: result?.error || 'No response from eBay for this item',
            }).eq('id', item.id);
            failedCount++;
          }
        }
      } catch (batchErr: any) {
        // Entire batch request failed
        for (const item of batch) {
          await supabaseAdmin.from('ebay_listing_items').update({
            status: 'failed',
            error_message: batchErr.message || 'Network error calling eBay API',
          }).eq('id', item.id);
          failedCount++;
        }
      }
    }

    // Update job status
    await supabaseAdmin.from('ebay_listing_jobs').update({
      listed_count: listedCount,
      failed_count: failedCount,
      status: 'completed',
      completed_at: new Date().toISOString(),
    }).eq('id', job.id);

    // Return full results
    const { data: finalItems } = await supabaseAdmin
      .from('ebay_listing_items')
      .select('*')
      .eq('job_id', job.id)
      .order('created_at');

    return NextResponse.json({
      job: {
        ...job,
        listed_count: listedCount,
        failed_count: failedCount,
        status: 'completed',
      },
      items: finalItems,
    });
  } catch (err: any) {
    console.error('Bulk list error:', err);
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}

// ============================================================================
// GET — Fetch job status and items
// ============================================================================
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const jobId = searchParams.get('jobId');

  if (!jobId) {
    return NextResponse.json({ error: 'jobId is required' }, { status: 400 });
  }

  const { data: job, error: jobError } = await supabaseAdmin
    .from('ebay_listing_jobs')
    .select('*')
    .eq('id', jobId)
    .single();

  if (jobError) {
    return NextResponse.json({ error: jobError.message }, { status: 500 });
  }

  const { data: items, error: itemsError } = await supabaseAdmin
    .from('ebay_listing_items')
    .select('*')
    .eq('job_id', jobId)
    .order('created_at');

  if (itemsError) {
    return NextResponse.json({ error: itemsError.message }, { status: 500 });
  }

  return NextResponse.json({ job, items });
}
