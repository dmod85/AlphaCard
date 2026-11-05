import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { generateListing } from '@/app/lib/card-listing/claude';

export const maxDuration = 120;

const MAX_IMAGES = 6;

// POST { image_urls: string[], notes?: string } → GeneratedListing
export async function POST(request: NextRequest) {
  try {
    const { image_urls, notes } = await request.json();

    if (!Array.isArray(image_urls) || image_urls.length === 0) {
      return NextResponse.json({ error: 'Upload at least one photo of the card' }, { status: 400 });
    }
    if (image_urls.length > MAX_IMAGES) {
      return NextResponse.json({ error: `Use at most ${MAX_IMAGES} photos per card` }, { status: 400 });
    }
    if (!image_urls.every((u: unknown) => typeof u === 'string' && u.startsWith('https://'))) {
      return NextResponse.json({ error: 'Image URLs must be https links' }, { status: 400 });
    }

    const listing = await generateListing(image_urls, typeof notes === 'string' ? notes : undefined);
    return NextResponse.json({ listing });
  } catch (err: any) {
    console.error('[listing-generator] error:', err);
    const status = err instanceof Anthropic.RateLimitError ? 429 : 500;
    return NextResponse.json({ error: err.message || 'Failed to generate listing' }, { status });
  }
}
