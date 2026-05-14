import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabase-admin';
import { getValidToken, isOAuthToken, getEbayApiHeaders, getEbayApiUrl } from '@/app/lib/ebay-auth';

// eBay Trading API config — uses shared helpers from ebay-auth.ts

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

// Updated buildItemXml to accept an ARRAY of items. 
// If the array has 1 item, it builds a normal listing. 
// If it has >1 items, it builds a variation listing.
function buildItemXml(items: any[]): string {
  const parent = items[0];
  const categoryId = CATEGORY_MAP[parent.sport] || CATEGORY_MAP.other;
  const conditionId = parent.condition === 'graded' ? CONDITION_GRADED : CONDITION_UNGRADED;

  const title = parent.title || [
    parent.card_year,
    parent.card_set,
    parent.player_name,
    parent.card_number ? `#${parent.card_number}` : ''
  ].filter(Boolean).join(' ').slice(0, 80);

  // Standard Condition Descriptors
  let conditionDescriptors = `
      <ConditionDescriptors>
        <ConditionDescriptor><Name>Card Condition</Name><Value>Near Mint or Better</Value></ConditionDescriptor>
      </ConditionDescriptors>`;

  // Item Specifics
  const specifics: { name: string; value: string }[] = [];
  if (parent.sport) specifics.push({ name: 'Sport', value: parent.sport.toUpperCase() });
  if (parent.card_year) specifics.push({ name: 'Year Manufactured', value: String(parent.card_year) });
  if (parent.card_set) specifics.push({ name: 'Set', value: parent.card_set });

  const itemSpecificsXml = specifics.length > 0 ? `
    <ItemSpecifics>
      ${specifics.map(s => `<NameValueList><Name>${escapeXml(s.name)}</Name><Value>${escapeXml(s.value)}</Value></NameValueList>`).join('\n      ')}
    </ItemSpecifics>` : '';

  // --- VARIATION LOGIC ---
  const isVariation = items.length > 1;

  // Description
  let description = 'Cards ship securely from the United States. Please message with any questions.';
  if (!isVariation) {
    const item = items[0];
    const descParts: string[] = [];
    if (item.player_name) descParts.push(item.player_name);
    if (item.card_year && item.card_set) descParts.push(`${item.card_year} ${item.card_set}`);
    else if (item.card_year) descParts.push(String(item.card_year));
    else if (item.card_set) descParts.push(item.card_set);
    if (item.card_number) descParts.push(`Card #${item.card_number}`);
    if (item.condition === 'graded' && item.grader) {
      descParts.push(`Graded ${item.grader} ${item.grade || ''}`.trim());
      if (item.cert_number) descParts.push(`Cert #${item.cert_number}`);
    } else {
      descParts.push('Near Mint or Better (NM+) condition.');
    }
    descParts.push('Ships from the United States. Please message with any questions.');
    description = descParts.join(' | ');
  }

  let variationsXml = '';
  let startPriceXml = `<StartPrice>${parent.price.toFixed(2)}</StartPrice>`;
  let quantityXml = `<Quantity>${parent.quantity || 1}</Quantity>`;
  let pictureXml = parent.image_urls?.length ? `<PictureDetails><PictureURL>${escapeXml(parent.image_urls[0])}</PictureURL></PictureDetails>` : '';

  if (isVariation) {
    // When using variations, StartPrice and Quantity are moved INSIDE the variation block
    startPriceXml = '';
    quantityXml = '';

    // Extract unique player names to define the variation options
    const playerNames = items.map(i => i.player_name).filter(Boolean);

    // We associate pictures with the Player Name variation trait
    const variationPictures = items
      .filter(i => i.image_urls && i.image_urls.length > 0)
      .map(i => `
        <VariationSpecificPictureSet>
          <VariationSpecificValue>${escapeXml(i.player_name)}</VariationSpecificValue>
          <PictureURL>${escapeXml(i.image_urls[0])}</PictureURL>
        </VariationSpecificPictureSet>
      `).join('');

    const variationDetails = items.map((item, index) => `
      <Variation>
        <SKU>VAR-${index}</SKU>
        <StartPrice>${item.price.toFixed(2)}</StartPrice>
        <Quantity>${item.quantity || 1}</Quantity>
        <VariationSpecifics>
          <NameValueList>
            <Name>Player/Athlete</Name>
            <Value>${escapeXml(item.player_name)}</Value>
          </NameValueList>
        </VariationSpecifics>
      </Variation>
    `).join('');

    variationsXml = `
      <Variations>
        <VariationSpecificsSet>
          <NameValueList>
            <Name>Player/Athlete</Name>
            ${playerNames.map(name => `<Value>${escapeXml(name)}</Value>`).join('')}
          </NameValueList>
        </VariationSpecificsSet>
        ${variationDetails}
        <Pictures>
          <VariationSpecificName>Player/Athlete</VariationSpecificName>
          ${variationPictures}
        </Pictures>
      </Variations>
    `;
  }

  return `
    <Item>
      <Title>${escapeXml(title)}</Title>
      <Description><![CDATA[${description}]]></Description>
      <PrimaryCategory><CategoryID>${categoryId}</CategoryID></PrimaryCategory>
      <ConditionID>${conditionId}</ConditionID>
      ${conditionDescriptors}
      ${startPriceXml}
      ${quantityXml}
      <ListingType>FixedPriceItem</ListingType>
      <ListingDuration>GTC</ListingDuration>
      <BestOfferDetails><BestOfferEnabled>true</BestOfferEnabled></BestOfferDetails>
      <Location>United States</Location>
      <Country>US</Country>
      <Currency>USD</Currency>
      <DispatchTimeMax>3</DispatchTimeMax>
      <ShippingDetails>
        <ShippingType>Flat</ShippingType>
        <ShippingServiceOptions>
          <ShippingServicePriority>1</ShippingServicePriority>
          <ShippingService>USPSMedia</ShippingService>
          <ShippingServiceCost>1.19</ShippingServiceCost>
        </ShippingServiceOptions>
      </ShippingDetails>
      <ReturnPolicy>
        <ReturnsAcceptedOption>ReturnsNotAccepted</ReturnsAcceptedOption>
      </ReturnPolicy>
      ${itemSpecificsXml}
      ${isVariation ? variationsXml : pictureXml}
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



async function callEbayApi(xmlBody: string, token: string): Promise<string> {
  const response = await fetch(getEbayApiUrl(), {
    method: 'POST',
    headers: getEbayApiHeaders('AddItems', token),
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

    const ebayToken = await getValidToken();

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
    // 1. Group items by Title to detect variations
    const groupedItems: Record<string, any[]> = {};
    insertedItems.forEach((item) => {
      if (!groupedItems[item.title]) {
        groupedItems[item.title] = [];
      }
      groupedItems[item.title].push(item);
    });

    // 2. Convert grouped dictionary back to an array of "Listings"
    const listingsToProcess = Object.values(groupedItems);

    // 3. Process in batches of 5 (eBay AddItems limit)
    let listedCount = 0;
    let failedCount = 0;

    for (let i = 0; i < listingsToProcess.length; i += 5) {
      const batch = listingsToProcess.slice(i, i + 5);

      try {
        // Build the XML. Notice we are passing the grouped array to buildItemXml now
        const credentials = isOAuthToken(ebayToken) ? '' : `<RequesterCredentials><eBayAuthToken>${ebayToken}</eBayAuthToken></RequesterCredentials>`;

        const xmlRequest = `<?xml version="1.0" encoding="utf-8"?>
        <AddItemsRequest xmlns="urn:ebay:apis:eBLBaseComponents">
          ${credentials}
          <ErrorLanguage>en_US</ErrorLanguage>
          <WarningLevel>High</WarningLevel>
          ${batch.map(itemGroup => `<AddItemRequestContainer>
            <MessageID>${itemGroup[0].id}</MessageID>
            ${buildItemXml(itemGroup)}
          </AddItemRequestContainer>`).join('\n')}
        </AddItemsRequest>`;

        const xmlResponse = await callEbayApi(xmlRequest, ebayToken);
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
