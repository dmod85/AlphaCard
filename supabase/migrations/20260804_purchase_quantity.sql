-- ============================================================================
-- AlphaCard: Track number of cards per purchase lot/box
-- Adds card_purchases.quantity and rolls it into the sales summary view.
-- Safe to re-run.
-- ============================================================================

ALTER TABLE card_purchases
  ADD COLUMN IF NOT EXISTS quantity INTEGER NOT NULL DEFAULT 1;

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
  COUNT(DISTINCT s.id)          AS sale_count,
  SUM(p.quantity)                    AS total_quantity,
  COALESCE(SUM(s.quantity_sold), 0)  AS quantity_sold
FROM card_purchases p
LEFT JOIN ebay_sales s ON s.sku = p.sku
GROUP BY p.sku, p.brand, p.series, p.sport;
