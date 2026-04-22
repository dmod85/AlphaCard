// ============================================================================
// AlphaCard Type Definitions
// ============================================================================

export type LeadStatus = 'new' | 'reviewing' | 'purchased' | 'dismissed' | 'expired' | 'listed';
export type HunterSource = 'typo_hunter' | 'holo_heuristic' | 'stale_sniper' | 'manual';
export type ShippingTier = 'ese' | 'bmwt' | 'tracked';
export type GradingStatus = 'raw' | 'submitted' | 'graded' | 'crossover';
export type CardSport = 'nfl' | 'nba' | 'mlb' | 'nhl' | 'soccer' | 'other';

export interface Lead {
  id: string;
  ebay_item_id: string;
  title: string;
  seller: string | null;
  current_price: number;
  buy_it_now: boolean;
  best_offer: boolean;
  listing_type: 'fixed' | 'auction';
  image_url: string | null;
  item_url: string;
  
  player_name: string | null;
  card_year: number | null;
  card_set: string | null;
  card_number: string | null;
  parallel_type: string | null;
  sport: CardSport;
  
  hunter_source: HunterSource;
  confidence: number;
  alpha_reason: string | null;
  typo_original: string | null;
  
  median_comp: number | null;
  comp_count: number;
  estimated_profit: number | null;
  roi_pct: number | null;
  
  shipping_tier: ShippingTier;
  shipping_cost: number;
  ebay_fees: number | null;
  
  status: LeadStatus;
  flagged: boolean;
  death_zone: boolean;
  grade_candidate: boolean;
  notes: string | null;
  
  days_active: number;
  listing_date: string | null;
  discovered_at: string;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface InventoryCard {
  id: string;
  lead_id: string | null;
  ebay_item_id: string | null;
  player_name: string;
  card_year: number | null;
  card_set: string | null;
  card_number: string | null;
  parallel_type: string | null;
  sport: CardSport;
  purchase_price: number;
  purchase_date: string;
  shipping_paid: number;
  total_cost: number;
  grading_status: GradingStatus;
  grading_cost: number;
  grade_received: string | null;
  listed_price: number | null;
  listed_date: string | null;
  sold_price: number | null;
  sold_date: string | null;
  net_profit: number | null;
  roi_pct: number | null;
  status: string;
  notes: string | null;
}

export interface SoldComp {
  id: string;
  ebay_item_id: string;
  title: string;
  sold_price: number;
  sold_date: string;
  item_url: string | null;
  image_url: string | null;
  is_outlier: boolean;
  outlier_reason: string | null;
}

export interface HunterRun {
  id: string;
  hunter_type: HunterSource;
  started_at: string;
  finished_at: string | null;
  leads_found: number;
  items_scanned: number;
  errors: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
}

export interface WatchlistPlayer {
  id: string;
  player_name: string;
  sport: CardSport;
  team: string | null;
  priority: number;
  aliases: string[];
  common_typos: string[];
  target_sets: string[];
  target_years: number[];
  min_value: number;
  max_buy_price: number | null;
  active: boolean;
}

export interface DashboardStats {
  total_leads: number;
  new_leads: number;
  total_potential_profit: number;
  avg_confidence: number;
  leads_by_hunter: Record<HunterSource, number>;
  leads_by_sport: Record<CardSport, number>;
  recent_runs: HunterRun[];
}

export interface InventorySummary {
  sport: CardSport;
  total_cards: number;
  listed: number;
  sold: number;
  total_invested: number;
  total_profit: number;
  avg_roi: number;
}

// ============================================================================
// eBay Bulk Listing Types
// ============================================================================

export interface EbayListingJob {
  id: string;
  total_items: number;
  listed_count: number;
  failed_count: number;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  created_at: string;
  completed_at: string | null;
}

export interface EbayListingItem {
  id: string;
  job_id: string;
  title: string;
  player_name: string | null;
  card_year: number | null;
  card_set: string | null;
  card_number: string | null;
  sport: string;
  condition: 'graded' | 'ungraded';
  grader: string | null;
  grade: string | null;
  cert_number: string | null;
  price: number;
  quantity: number;
  image_urls: string[] | null;
  ebay_item_id: string | null;
  ebay_listing_url: string | null;
  status: 'pending' | 'listed' | 'failed';
  error_message: string | null;
  created_at: string;
}

export interface BulkListStagingItem {
  id: string;
  title: string;
  player_name: string;
  card_year: number | null;
  card_set: string;
  card_number: string;
  sport: string;
  condition: 'graded' | 'ungraded';
  grader: string;
  grade: string;
  cert_number: string;
  price: number;
  quantity: number;
  image_urls: string[];
}
