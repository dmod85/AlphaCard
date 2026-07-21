-- ============================================================================
-- AlphaCard: Card Purchases + eBay Sales Tracker
-- Migration: card_purchases, ebay_sales, summary view
-- Safe to re-run (uses IF NOT EXISTS / OR REPLACE everywhere)
-- ============================================================================

CREATE TABLE IF NOT EXISTS card_purchases (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  purchase_date DATE NOT NULL DEFAULT CURRENT_DATE,
  year          INTEGER,
  brand         TEXT,
  series        TEXT,
  sport         TEXT,
  team          TEXT,
  box_size      TEXT,
  cost          NUMERIC(10, 2) NOT NULL DEFAULT 0,
  sku           TEXT,
  bought_from   TEXT DEFAULT 'eBay',
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_purchases_sku   ON card_purchases(sku);
CREATE INDEX IF NOT EXISTS idx_purchases_date  ON card_purchases(purchase_date DESC);
CREATE INDEX IF NOT EXISTS idx_purchases_brand ON card_purchases(brand);
CREATE INDEX IF NOT EXISTS idx_purchases_sport ON card_purchases(sport);

CREATE TABLE IF NOT EXISTS ebay_sales (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_number  TEXT NOT NULL,
  item_title    TEXT NOT NULL,
  sku           TEXT,
  sold_for      NUMERIC(10, 2) NOT NULL DEFAULT 0,
  sale_date     TIMESTAMPTZ,
  ebay_item_id  TEXT,
  buyer         TEXT,
  quantity_sold INTEGER DEFAULT 1,
  picture_url   TEXT,                    -- eBay GalleryURL
  synced_at     TIMESTAMPTZ DEFAULT NOW(),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (order_number, ebay_item_id)
);

CREATE INDEX IF NOT EXISTS idx_sales_sku   ON ebay_sales(sku);
CREATE INDEX IF NOT EXISTS idx_sales_order ON ebay_sales(order_number);
CREATE INDEX IF NOT EXISTS idx_sales_date  ON ebay_sales(sale_date DESC);

CREATE OR REPLACE VIEW v_purchase_sales_summary AS
SELECT
  p.sku,
  p.brand,
  p.series,
  p.sport,
  COUNT(DISTINCT p.id)          AS purchase_count,
  SUM(p.cost)                   AS total_spent,
  COALESCE(SUM(s.sold_for), 0)  AS total_revenue,
  COALESCE(SUM(s.sold_for), 0) - SUM(p.cost) AS net_profit,
  COUNT(DISTINCT s.id)          AS sale_count
FROM card_purchases p
LEFT JOIN ebay_sales s ON s.sku = p.sku
GROUP BY p.sku, p.brand, p.series, p.sport;

-- Trigger (wrapped in DO block so it's safe to re-run)
DO $$ BEGIN
  CREATE TRIGGER trg_purchases_updated
    BEFORE UPDATE ON card_purchases
    FOR EACH ROW EXECUTE FUNCTION update_modified_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE card_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE ebay_sales     ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Service role full access" ON card_purchases FOR ALL
    USING (auth.role() = 'service_role');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Service role full access" ON ebay_sales FOR ALL
    USING (auth.role() = 'service_role');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
