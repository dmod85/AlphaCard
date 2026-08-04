-- ============================================================================
-- SEARCH QUERIES: eBay searches driving the Discord alert script (api/index.py)
-- ============================================================================

CREATE TABLE search_queries (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  query       TEXT NOT NULL,
  max_price   NUMERIC(10, 2) NOT NULL,
  active      BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_search_queries_active ON search_queries(active) WHERE active = TRUE;

-- Seed with the queries that were previously hardcoded in the script
INSERT INTO search_queries (query, max_price) VALUES
  ('Sophie Cunningham Card', 3),
  ('Sophie Cunningham Lot', 75);

-- ============================================================================
-- SEEN ITEMS: dedup log so the same eBay listing isn't alerted twice
-- ============================================================================

CREATE TABLE seen_items (
  item_id     TEXT PRIMARY KEY,
  title       TEXT,
  price       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
