-- ============================================================================
-- AlphaCard: Lot / box pool ROI
-- Allocation mode + expected bulk recovery on purchases, and per-card/line
-- items under a pool (weighted / residual / status).
-- Safe to re-run.
-- ============================================================================

ALTER TABLE card_purchases
  ADD COLUMN IF NOT EXISTS allocation_mode TEXT NOT NULL DEFAULT 'equal';

ALTER TABLE card_purchases
  ADD COLUMN IF NOT EXISTS expected_bulk_recovery NUMERIC(10, 2) NOT NULL DEFAULT 0;

DO $$ BEGIN
  ALTER TABLE card_purchases
    ADD CONSTRAINT card_purchases_allocation_mode_check
    CHECK (allocation_mode IN ('equal', 'weighted', 'residual'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS purchase_pool_items (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  purchase_id     UUID NOT NULL REFERENCES card_purchases(id) ON DELETE CASCADE,
  label           TEXT,
  estimated_value NUMERIC(10, 2) NOT NULL DEFAULT 0,
  allocated_cost  NUMERIC(10, 2),
  status          TEXT NOT NULL DEFAULT 'in_stock'
                    CHECK (status IN ('in_stock', 'listed', 'sold', 'hold', 'pc', 'bulk_leftover')),
  qty             INTEGER NOT NULL DEFAULT 1,
  sale_id         UUID REFERENCES ebay_sales(id) ON DELETE SET NULL,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pool_items_purchase ON purchase_pool_items(purchase_id);
CREATE INDEX IF NOT EXISTS idx_pool_items_status   ON purchase_pool_items(status);
CREATE INDEX IF NOT EXISTS idx_pool_items_sale     ON purchase_pool_items(sale_id);

ALTER TABLE purchase_pool_items ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Service role full access" ON purchase_pool_items FOR ALL
    USING (auth.role() = 'service_role');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_pool_items_updated
    BEFORE UPDATE ON purchase_pool_items
    FOR EACH ROW EXECUTE FUNCTION update_modified_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE OR REPLACE VIEW v_purchase_sales_summary AS
SELECT
  p.sku,
  p.brand,
  p.series,
  p.sport,
  COUNT(DISTINCT p.id)               AS purchase_count,
  SUM(p.cost)                        AS total_spent,
  COALESCE(SUM(s.sold_for), 0)       AS total_revenue,
  COALESCE(SUM(s.sold_for), 0) - SUM(p.cost) AS net_profit,
  COUNT(DISTINCT s.id)               AS sale_count,
  SUM(p.quantity)                    AS total_quantity,
  COALESCE(SUM(s.quantity_sold), 0)  AS quantity_sold
FROM card_purchases p
LEFT JOIN ebay_sales s ON s.sku = p.sku
GROUP BY p.sku, p.brand, p.series, p.sport;
