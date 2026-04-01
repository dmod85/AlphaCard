-- ============================================================================
-- AlphaCard: Sourcing & Resale Engine
-- Migration 001: Core Schema
-- ============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";      -- Trigram similarity for fuzzy search
CREATE EXTENSION IF NOT EXISTS "fuzzystrmatch"; -- Levenshtein distance

-- ============================================================================
-- ENUMS
-- ============================================================================

CREATE TYPE lead_status AS ENUM (
  'new', 'reviewing', 'purchased', 'dismissed', 'expired', 'listed'
);

CREATE TYPE hunter_source AS ENUM (
  'typo_hunter', 'holo_heuristic', 'stale_sniper', 'manual'
);

CREATE TYPE shipping_tier AS ENUM (
  'ese',   -- Ebay Standard Envelope ($0.63)
  'bmwt',  -- Bubble Mailer with Tracking ($4.50)
  'tracked' -- Full tracked package ($8.00+)
);

CREATE TYPE grading_status AS ENUM (
  'raw', 'submitted', 'graded', 'crossover'
);

CREATE TYPE card_sport AS ENUM (
  'nfl', 'nba', 'mlb', 'nhl', 'soccer', 'other'
);

-- ============================================================================
-- RAW LEADS: Where every potential flip starts
-- ============================================================================

CREATE TABLE raw_leads (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ebay_item_id    TEXT UNIQUE NOT NULL,
  title           TEXT NOT NULL,
  seller          TEXT,
  current_price   NUMERIC(10, 2) NOT NULL,
  buy_it_now      BOOLEAN DEFAULT FALSE,
  best_offer      BOOLEAN DEFAULT FALSE,
  listing_type    TEXT CHECK (listing_type IN ('fixed', 'auction')),
  image_url       TEXT,
  item_url        TEXT NOT NULL,
  
  -- Classification
  player_name     TEXT,
  card_year       INTEGER,
  card_set        TEXT,
  card_number     TEXT,
  parallel_type   TEXT,  -- e.g., 'Prizm Silver', 'Refractor', 'Base'
  sport           card_sport DEFAULT 'nfl',
  
  -- Alpha detection metadata
  hunter_source   hunter_source NOT NULL DEFAULT 'manual',
  confidence      NUMERIC(5, 2) DEFAULT 0,  -- 0-100 confidence score
  alpha_reason    TEXT,  -- Human-readable explanation of why this is a lead
  typo_original   TEXT,  -- The original misspelled query that found it
  
  -- Comp data (denormalized for speed)
  median_comp     NUMERIC(10, 2),
  comp_count      INTEGER DEFAULT 0,
  estimated_profit NUMERIC(10, 2),
  roi_pct         NUMERIC(6, 2),
  
  -- Shipping & profitability
  shipping_tier   shipping_tier DEFAULT 'ese',
  shipping_cost   NUMERIC(6, 2) DEFAULT 0.63,
  ebay_fees       NUMERIC(6, 2),
  
  -- Workflow
  status          lead_status DEFAULT 'new',
  flagged         BOOLEAN DEFAULT FALSE,
  death_zone      BOOLEAN DEFAULT FALSE,  -- $20-$25 danger zone
  grade_candidate BOOLEAN DEFAULT FALSE,
  notes           TEXT,
  
  -- Timestamps
  listing_date    TIMESTAMPTZ,
  days_active     INTEGER DEFAULT 0,
  discovered_at   TIMESTAMPTZ DEFAULT NOW(),
  reviewed_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for fast querying
CREATE INDEX idx_leads_status ON raw_leads(status);
CREATE INDEX idx_leads_hunter ON raw_leads(hunter_source);
CREATE INDEX idx_leads_sport ON raw_leads(sport);
CREATE INDEX idx_leads_profit ON raw_leads(estimated_profit DESC);
CREATE INDEX idx_leads_confidence ON raw_leads(confidence DESC);
CREATE INDEX idx_leads_player ON raw_leads USING gin(player_name gin_trgm_ops);
CREATE INDEX idx_leads_title ON raw_leads USING gin(title gin_trgm_ops);
CREATE INDEX idx_leads_discovered ON raw_leads(discovered_at DESC);

-- ============================================================================
-- SOLD COMPS: Historical pricing cache
-- ============================================================================

CREATE TABLE sold_comps (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ebay_item_id    TEXT UNIQUE NOT NULL,
  title           TEXT NOT NULL,
  sold_price      NUMERIC(10, 2) NOT NULL,
  sold_date       TIMESTAMPTZ NOT NULL,
  
  -- Classification (for matching)
  player_name     TEXT,
  card_year       INTEGER,
  card_set        TEXT,
  card_number     TEXT,
  parallel_type   TEXT,
  graded          BOOLEAN DEFAULT FALSE,
  grade_company   TEXT,
  grade_value     TEXT,
  sport           card_sport DEFAULT 'nfl',
  
  -- Outlier detection
  is_outlier      BOOLEAN DEFAULT FALSE,
  outlier_reason  TEXT,
  
  -- Metadata
  image_url       TEXT,
  item_url        TEXT,
  fetched_at      TIMESTAMPTZ DEFAULT NOW(),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_comps_player ON sold_comps USING gin(player_name gin_trgm_ops);
CREATE INDEX idx_comps_date ON sold_comps(sold_date DESC);
CREATE INDEX idx_comps_price ON sold_comps(sold_price);
CREATE INDEX idx_comps_set ON sold_comps(card_set, card_number);
CREATE INDEX idx_comps_sport ON sold_comps(sport);

-- ============================================================================
-- INVENTORY: Track your purchased cards
-- ============================================================================

CREATE TABLE inventory (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id         UUID REFERENCES raw_leads(id),
  ebay_item_id    TEXT,
  
  -- Card details
  player_name     TEXT NOT NULL,
  card_year       INTEGER,
  card_set        TEXT,
  card_number     TEXT,
  parallel_type   TEXT,
  sport           card_sport DEFAULT 'nfl',
  
  -- Financials
  purchase_price  NUMERIC(10, 2) NOT NULL,
  purchase_date   TIMESTAMPTZ DEFAULT NOW(),
  shipping_paid   NUMERIC(6, 2) DEFAULT 0,
  total_cost      NUMERIC(10, 2) GENERATED ALWAYS AS (purchase_price + shipping_paid) STORED,
  
  -- Grading
  grading_status  grading_status DEFAULT 'raw',
  grading_cost    NUMERIC(6, 2) DEFAULT 0,
  grade_received  TEXT,
  grade_company   TEXT,
  
  -- Listing
  listed_price    NUMERIC(10, 2),
  listed_date     TIMESTAMPTZ,
  listed_ebay_id  TEXT,
  shipping_tier   shipping_tier DEFAULT 'ese',
  
  -- Sale
  sold_price      NUMERIC(10, 2),
  sold_date       TIMESTAMPTZ,
  ebay_fees_paid  NUMERIC(6, 2),
  shipping_cost   NUMERIC(6, 2),
  
  -- Computed profit (NULL until sold)
  net_profit      NUMERIC(10, 2),
  roi_pct         NUMERIC(6, 2),
  
  -- Status
  status          TEXT DEFAULT 'in_hand' CHECK (status IN (
    'in_transit', 'in_hand', 'at_grader', 'listed', 'sold', 'returned'
  )),
  notes           TEXT,
  
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_inventory_status ON inventory(status);
CREATE INDEX idx_inventory_player ON inventory(player_name);
CREATE INDEX idx_inventory_sport ON inventory(sport);
CREATE INDEX idx_inventory_profit ON inventory(net_profit DESC);

-- ============================================================================
-- HUNTER RUNS: Track each scan cycle
-- ============================================================================

CREATE TABLE hunter_runs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  hunter_type     hunter_source NOT NULL,
  started_at      TIMESTAMPTZ DEFAULT NOW(),
  finished_at     TIMESTAMPTZ,
  leads_found     INTEGER DEFAULT 0,
  items_scanned   INTEGER DEFAULT 0,
  errors          INTEGER DEFAULT 0,
  error_log       JSONB DEFAULT '[]',
  config_used     JSONB,  -- Snapshot of config at runtime
  status          TEXT DEFAULT 'running' CHECK (status IN (
    'running', 'completed', 'failed', 'cancelled'
  ))
);

-- ============================================================================
-- PLAYER WATCHLIST: Who we're hunting for
-- ============================================================================

CREATE TABLE player_watchlist (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  player_name     TEXT NOT NULL,
  sport           card_sport NOT NULL,
  team            TEXT,
  priority        INTEGER DEFAULT 5 CHECK (priority BETWEEN 1 AND 10),
  
  -- Known misspellings / aliases (for typo hunter)
  aliases         TEXT[] DEFAULT '{}',
  common_typos    TEXT[] DEFAULT '{}',
  
  -- Card sets to focus on
  target_sets     TEXT[] DEFAULT '{}',
  target_years    INTEGER[] DEFAULT '{}',
  
  -- Thresholds
  min_value       NUMERIC(10, 2) DEFAULT 5.00,
  max_buy_price   NUMERIC(10, 2),
  
  active          BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_watchlist_player ON player_watchlist USING gin(player_name gin_trgm_ops);
CREATE INDEX idx_watchlist_sport ON player_watchlist(sport);
CREATE INDEX idx_watchlist_active ON player_watchlist(active) WHERE active = TRUE;

-- ============================================================================
-- NOTIFICATION LOG
-- ============================================================================

CREATE TABLE notifications (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id         UUID REFERENCES raw_leads(id),
  channel         TEXT NOT NULL CHECK (channel IN ('discord', 'pushover', 'email')),
  message         TEXT NOT NULL,
  sent_at         TIMESTAMPTZ DEFAULT NOW(),
  delivered       BOOLEAN DEFAULT FALSE,
  error           TEXT
);

-- ============================================================================
-- FUNCTIONS & TRIGGERS
-- ============================================================================

-- Auto-update `updated_at`
CREATE OR REPLACE FUNCTION update_modified_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_leads_updated
  BEFORE UPDATE ON raw_leads
  FOR EACH ROW EXECUTE FUNCTION update_modified_column();

CREATE TRIGGER trg_inventory_updated
  BEFORE UPDATE ON inventory
  FOR EACH ROW EXECUTE FUNCTION update_modified_column();

CREATE TRIGGER trg_watchlist_updated
  BEFORE UPDATE ON player_watchlist
  FOR EACH ROW EXECUTE FUNCTION update_modified_column();

-- Death zone detection trigger
CREATE OR REPLACE FUNCTION check_death_zone()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.median_comp BETWEEN 20 AND 25 THEN
    NEW.death_zone = TRUE;
    NEW.alpha_reason = COALESCE(NEW.alpha_reason, '') || ' ⚠️ DEATH ZONE: Value between $20-$25.';
  ELSE
    NEW.death_zone = FALSE;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_death_zone
  BEFORE INSERT OR UPDATE OF median_comp ON raw_leads
  FOR EACH ROW EXECUTE FUNCTION check_death_zone();

-- Auto-calculate shipping tier
CREATE OR REPLACE FUNCTION auto_shipping_tier()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.median_comp IS NOT NULL THEN
    IF NEW.median_comp < 20 THEN
      NEW.shipping_tier = 'ese';
      NEW.shipping_cost = 0.63;
    ELSIF NEW.median_comp < 50 THEN
      NEW.shipping_tier = 'bmwt';
      NEW.shipping_cost = 4.50;
    ELSE
      NEW.shipping_tier = 'tracked';
      NEW.shipping_cost = 8.00;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_shipping_tier
  BEFORE INSERT OR UPDATE OF median_comp ON raw_leads
  FOR EACH ROW EXECUTE FUNCTION auto_shipping_tier();

-- Auto-calculate estimated profit and eBay fees
CREATE OR REPLACE FUNCTION calc_profit()
RETURNS TRIGGER AS $$
DECLARE
  fee_rate NUMERIC := 0.1331;  -- eBay final value fee (13.31%)
BEGIN
  IF NEW.median_comp IS NOT NULL AND NEW.current_price IS NOT NULL THEN
    NEW.ebay_fees = ROUND(NEW.median_comp * fee_rate, 2);
    NEW.estimated_profit = ROUND(
      NEW.median_comp - NEW.current_price - NEW.shipping_cost - NEW.ebay_fees, 2
    );
    IF NEW.current_price > 0 THEN
      NEW.roi_pct = ROUND(
        (NEW.estimated_profit / NEW.current_price) * 100, 2
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_calc_profit
  BEFORE INSERT OR UPDATE OF median_comp, current_price, shipping_cost ON raw_leads
  FOR EACH ROW EXECUTE FUNCTION calc_profit();

-- Grading ROI check
CREATE OR REPLACE FUNCTION check_grading_candidate()
RETURNS TRIGGER AS $$
BEGIN
  -- If PSA 10 multiplier makes it worth grading (placeholder logic)
  -- We flag anything where median comp > $50 and ROI > 100%
  IF NEW.median_comp > 50 AND NEW.roi_pct > 100 THEN
    NEW.grade_candidate = TRUE;
  ELSE
    NEW.grade_candidate = FALSE;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_grading_check
  BEFORE INSERT OR UPDATE OF median_comp, roi_pct ON raw_leads
  FOR EACH ROW EXECUTE FUNCTION check_grading_candidate();

-- ============================================================================
-- ROW LEVEL SECURITY (enable for production)
-- ============================================================================

ALTER TABLE raw_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE sold_comps ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE hunter_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_watchlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- Policies (service role bypasses RLS; anon gets read-only on leads)
CREATE POLICY "Service role full access" ON raw_leads FOR ALL
  USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access" ON sold_comps FOR ALL
  USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access" ON inventory FOR ALL
  USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access" ON hunter_runs FOR ALL
  USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access" ON player_watchlist FOR ALL
  USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access" ON notifications FOR ALL
  USING (auth.role() = 'service_role');

-- ============================================================================
-- VIEWS: Pre-computed dashboards
-- ============================================================================

CREATE VIEW v_hot_leads AS
SELECT 
  id, ebay_item_id, title, player_name, sport,
  current_price, median_comp, estimated_profit, roi_pct,
  confidence, hunter_source, alpha_reason,
  shipping_tier, death_zone, grade_candidate,
  days_active, buy_it_now, best_offer,
  image_url, item_url, status, discovered_at
FROM raw_leads
WHERE status = 'new'
  AND death_zone = FALSE
  AND estimated_profit > 3
ORDER BY confidence DESC, estimated_profit DESC;

CREATE VIEW v_inventory_summary AS
SELECT 
  sport,
  COUNT(*) as total_cards,
  COUNT(*) FILTER (WHERE status = 'listed') as listed,
  COUNT(*) FILTER (WHERE status = 'sold') as sold,
  SUM(total_cost) as total_invested,
  SUM(net_profit) FILTER (WHERE status = 'sold') as total_profit,
  ROUND(AVG(roi_pct) FILTER (WHERE status = 'sold'), 2) as avg_roi
FROM inventory
GROUP BY sport;

CREATE VIEW v_hunter_performance AS
SELECT 
  hunter_type,
  COUNT(*) as total_runs,
  SUM(leads_found) as total_leads,
  SUM(items_scanned) as total_scanned,
  ROUND(AVG(leads_found), 1) as avg_leads_per_run,
  MAX(finished_at) as last_run
FROM hunter_runs
WHERE status = 'completed'
GROUP BY hunter_type;

-- ============================================================================
-- SEED DATA: Initial watchlist
-- ============================================================================

INSERT INTO player_watchlist (player_name, sport, team, priority, common_typos, target_sets, target_years) VALUES
  ('C.J. Stroud', 'nfl', 'Houston Texans', 10, 
   ARRAY['CJ Stroude', 'C J Stroud', 'Stroud CJ', 'Cj Stoud'], 
   ARRAY['Prizm', 'Select', 'Optic', 'Mosaic'], ARRAY[2023, 2024]),
  ('Caleb Williams', 'nfl', 'Chicago Bears', 10,
   ARRAY['Caleb Willams', 'Calib Williams', 'Caleb Willaims'],
   ARRAY['Prizm', 'Donruss', 'Select'], ARRAY[2024]),
  ('Victor Wembanyama', 'nba', 'San Antonio Spurs', 10,
   ARRAY['Wembenyama', 'Wembanyana', 'Wembanyma', 'Victor Wemby'],
   ARRAY['Prizm', 'Select', 'Optic', 'Court Kings'], ARRAY[2023, 2024]),
  ('Anthony Edwards', 'nba', 'Minnesota Timberwolves', 8,
   ARRAY['Anthony Edward', 'Antony Edwards', 'A Edwards'],
   ARRAY['Prizm', 'Select', 'Mosaic'], ARRAY[2020, 2021, 2022, 2023, 2024]),
  ('Caitlin Clark', 'nba', 'Indiana Fever', 9,
   ARRAY['Catlin Clark', 'Kaitlin Clark', 'Caitlyn Clark'],
   ARRAY['Prizm', 'Select', 'Optic'], ARRAY[2024]),
  ('Shohei Ohtani', 'mlb', 'Los Angeles Dodgers', 9,
   ARRAY['Shohei Otani', 'Ohtani Shohei', 'Shoehei Ohtani'],
   ARRAY['Topps Chrome', 'Bowman', 'Stadium Club'], ARRAY[2018, 2023, 2024]),
  ('Connor Bedard', 'nhl', 'Chicago Blackhawks', 8,
   ARRAY['Conner Bedard', 'Connor Beddard', 'Conor Bedard'],
   ARRAY['Upper Deck', 'O-Pee-Chee'], ARRAY[2023, 2024]),
  ('Pete Crow-Armstrong', 'mlb', 'Chicago Cubs', 7,
   ARRAY['Pete Crow Armstrong', 'Crow Armstrong', 'PCA Cubs'],
   ARRAY['Topps Chrome', 'Bowman Chrome', '1st Bowman'], ARRAY[2023, 2024])
ON CONFLICT DO NOTHING;
