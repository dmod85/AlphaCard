-- Sales hidden from revenue / ROI / COGS (the $2,050 one-off, personal pulls, etc.)
ALTER TABLE ebay_sales
  ADD COLUMN IF NOT EXISTS exclude_from_stats BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_ebay_sales_exclude_from_stats
  ON ebay_sales (exclude_from_stats)
  WHERE exclude_from_stats = TRUE;
