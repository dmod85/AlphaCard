import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import type { BetaContentBlock, BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { canonicalizeTitleAcronyms } from '@/app/lib/listing-title';
import {
  LISTING_SYSTEM_PROMPT,
  SOLD_COMPS_SYSTEM_PROMPT,
  buildListingUserText,
} from './prompt';
import { fitTitle } from './pricing';
import {
  LISTING_SCHEMA,
  SOLD_COMPS_SCHEMA,
  type GeneratedListing,
  type SoldComp,
} from './schema';

// Override with CARD_LISTING_MODEL (e.g. claude-haiku-5-5 for much cheaper runs).
const MODEL = process.env.CARD_LISTING_MODEL?.trim() || 'claude-opus-5-5';

// On a policy decline the API retries on its default fallback model inside
// the same call instead of returning an empty answer.
const FALLBACK = {
  betas: ['server-side-fallback-2026-07-01' as const],
  fallbacks: 'default' as const,
};

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    throw new Error('ANTHROPIC_API_KEY is not set. Add it to .env.local (and to Vercel env vars).');
  }
  client ??= new Anthropic();
  return client;
}

function finalText(content: BetaContentBlock[]): string {
  // With web search the answer can follow several tool blocks; the JSON is in
  // the last text block.
  const texts = content.filter((b): b is Extract<BetaContentBlock, { type: 'text' }> => b.type === 'text');
  return texts.at(-1)?.text ?? '';
}

function parseJson<T>(text: string, what: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Claude returned an unreadable ${what} (${text.slice(0, 120)}…)`);
  }
}

export async function generateListing(imageUrls: string[], notes?: string): Promise<GeneratedListing> {
  const response = await getClient().beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    ...FALLBACK,
    system: LISTING_SYSTEM_PROMPT,
    output_config: {
      effort: 'medium',
      format: { type: 'json_schema', schema: LISTING_SCHEMA },
    },
    messages: [
      {
        role: 'user',
        content: [
          ...imageUrls.map(url => ({ type: 'image' as const, source: { type: 'url' as const, url } })),
          { type: 'text', text: buildListingUserText(notes) },
        ],
      },
    ],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('Claude declined to process these photos.');
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error('Listing was cut off before it finished. Try again.');
  }

  const listing = parseJson<GeneratedListing>(finalText(response.content), 'listing');
  listing.title = fitTitle(canonicalizeTitleAcronyms(listing.title));
  listing.alt_titles = listing.alt_titles.map(t => fitTitle(canonicalizeTitleAcronyms(t)));
  listing.item_specifics = listing.item_specifics.filter(s => s.name.trim() && s.value.trim());
  return listing;
}

function describeForComps(listing: GeneratedListing): string {
  const c = listing.card;
  const facts = [
    ['Card', listing.title],
    ['Search query', listing.comp_search_query],
    ['Player', c.player_names.join(', ')],
    ['Year', c.year],
    ['Set', [c.manufacturer, c.set_name].filter(Boolean).join(' ')],
    ['Insert/subset', c.insert_or_subset],
    ['Card number', c.card_number],
    ['Parallel', c.parallel],
    ['Serial', c.serial_number],
    ['Graded', c.graded ? `${c.grader ?? ''} ${c.grade ?? ''}`.trim() || 'yes' : 'raw (ungraded)'],
    ['Autograph', c.autograph ? 'yes' : 'no'],
  ].filter(([, v]) => v);
  return `Find recent sold comps for this card:\n${facts.map(([k, v]) => `${k}: ${v}`).join('\n')}`;
}

export async function findSoldComps(listing: GeneratedListing): Promise<{ comps: SoldComp[]; notes: string | null }> {
  const messages: BetaMessageParam[] = [{ role: 'user', content: describeForComps(listing) }];

  // Server-side web search can pause a long turn; resend to let it continue.
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await getClient().beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      ...FALLBACK,
      system: SOLD_COMPS_SYSTEM_PROMPT,
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: SOLD_COMPS_SCHEMA },
      },
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 4 }],
      messages,
    });

    if (response.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content });
      continue;
    }
    if (response.stop_reason === 'refusal') {
      throw new Error('Claude declined the comp search.');
    }

    const parsed = parseJson<{ comps: SoldComp[]; notes: string | null }>(finalText(response.content), 'comp list');
    return {
      comps: parsed.comps.filter(c => Number.isFinite(c.price) && c.price > 0),
      notes: parsed.notes,
    };
  }
  throw new Error('Comp search took too long. Try again.');
}
