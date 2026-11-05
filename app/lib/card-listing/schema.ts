/**
 * Shared types + JSON schemas for the photo → listing generator.
 * The schemas are sent to Claude as structured-output formats, so every
 * object lists all its keys in `required` and sets additionalProperties
 * false; "optional" values are nullable instead.
 */

export interface ItemSpecific {
  name: string;
  value: string;
}

export interface CardIdentity {
  sport: string | null;
  year: string | null;
  manufacturer: string | null;
  set_name: string | null;
  insert_or_subset: string | null;
  player_names: string[];
  team: string | null;
  league: string | null;
  card_number: string | null;
  parallel: string | null;
  serial_number: string | null;
  print_run: number | null;
  rookie: boolean;
  autograph: boolean;
  memorabilia: boolean;
  graded: boolean;
  grader: string | null;
  grade: string | null;
  cert_number: string | null;
  condition_notes: string | null;
  confidence: 'high' | 'medium' | 'low';
  needs_review: string[];
}

export interface GeneratedListing {
  card: CardIdentity;
  title: string;
  alt_titles: string[];
  description: string;
  item_specifics: ItemSpecific[];
  keywords: string[];
  comp_search_query: string;
}

export interface SoldComp {
  title: string;
  price: number;
  sold_date: string | null;
  source: string;
  url: string | null;
  match: 'exact' | 'close';
}

export interface ActiveComp {
  title: string;
  price: number;
  url: string;
  image_url: string | null;
}

export interface OwnSale {
  title: string;
  price: number;
  sold_date: string | null;
}

export interface PriceSuggestion {
  quick_sale: number | null;
  suggested: number | null;
  high: number | null;
  confidence: 'high' | 'medium' | 'low' | 'none';
  basis: string;
}

export interface CompsResult {
  sold: SoldComp[];
  sold_notes: string | null;
  sold_error: string | null;
  active: ActiveComp[];
  active_error: string | null;
  own_sales: OwnSale[];
  price: PriceSuggestion;
}

const nullableString = { type: ['string', 'null'] };

export const LISTING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['card', 'title', 'alt_titles', 'description', 'item_specifics', 'keywords', 'comp_search_query'],
  properties: {
    card: {
      type: 'object',
      additionalProperties: false,
      required: [
        'sport', 'year', 'manufacturer', 'set_name', 'insert_or_subset', 'player_names', 'team', 'league',
        'card_number', 'parallel', 'serial_number', 'print_run', 'rookie', 'autograph', 'memorabilia',
        'graded', 'grader', 'grade', 'cert_number', 'condition_notes', 'confidence', 'needs_review',
      ],
      properties: {
        sport: nullableString,
        year: nullableString,
        manufacturer: nullableString,
        set_name: nullableString,
        insert_or_subset: nullableString,
        player_names: { type: 'array', items: { type: 'string' } },
        team: nullableString,
        league: nullableString,
        card_number: nullableString,
        parallel: nullableString,
        serial_number: nullableString,
        print_run: { type: ['integer', 'null'] },
        rookie: { type: 'boolean' },
        autograph: { type: 'boolean' },
        memorabilia: { type: 'boolean' },
        graded: { type: 'boolean' },
        grader: nullableString,
        grade: nullableString,
        cert_number: nullableString,
        condition_notes: nullableString,
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        needs_review: { type: 'array', items: { type: 'string' } },
      },
    },
    title: { type: 'string' },
    alt_titles: { type: 'array', items: { type: 'string' } },
    description: { type: 'string' },
    item_specifics: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'value'],
        properties: { name: { type: 'string' }, value: { type: 'string' } },
      },
    },
    keywords: { type: 'array', items: { type: 'string' } },
    comp_search_query: { type: 'string' },
  },
} as const;

export const SOLD_COMPS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['comps', 'notes'],
  properties: {
    comps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'price', 'sold_date', 'source', 'url', 'match'],
        properties: {
          title: { type: 'string' },
          price: { type: 'number' },
          sold_date: nullableString,
          source: { type: 'string' },
          url: nullableString,
          match: { type: 'string', enum: ['exact', 'close'] },
        },
      },
    },
    notes: nullableString,
  },
} as const;
