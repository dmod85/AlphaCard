-- ============================================================================
-- AlphaCard: Disk I/O & Query Performance Optimization
-- Adds missing indexes on high-frequency and polled queries to stop full
-- table sequential scans that exhaust the Supabase Disk IO burst budget.
-- Safe to re-run (uses IF NOT EXISTS everywhere).
-- ============================================================================

-- 1. ebay_webhook_events: Polled by print-agent and written by Vercel for print jobs.
-- Eliminates sequential scan + sort on every queue check.
CREATE INDEX IF NOT EXISTS idx_webhook_events_topic_received
  ON ebay_webhook_events(topic, received_at);

-- 2. ebay_sales: Partial indexes for high-frequency queries
-- Print agent catch-up & pending claims (checked on startup and slip generation)
CREATE INDEX IF NOT EXISTS idx_sales_print_pending
  ON ebay_sales(order_number, printed_at)
  WHERE packing_slip_url IS NOT NULL;

-- Fast lookup for recently printed check
CREATE INDEX IF NOT EXISTS idx_sales_printed_at
  ON ebay_sales(printed_at)
  WHERE printed_at IS NOT NULL;

-- Fast filter for sales with advertising fees during PnL calculations
CREATE INDEX IF NOT EXISTS idx_sales_advertising_fee
  ON ebay_sales(advertising_fee)
  WHERE advertising_fee IS NOT NULL;

-- 2b. Add exclude_from_stats column if not yet migrated, then add partial index
ALTER TABLE ebay_sales
  ADD COLUMN IF NOT EXISTS exclude_from_stats BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_sales_exclude_stats
  ON ebay_sales(exclude_from_stats)
  WHERE exclude_from_stats = TRUE;

-- 3. sold_comps: Historical comps queries filter on outlier status and sort by sold_date
CREATE INDEX IF NOT EXISTS idx_comps_outlier_date
  ON sold_comps(is_outlier, sold_date DESC);

-- 4. hunter_runs: Analytics and runner panel queries sort by started_at DESC
CREATE INDEX IF NOT EXISTS idx_hunter_runs_started
  ON hunter_runs(started_at DESC);

CREATE INDEX IF NOT EXISTS idx_hunter_runs_status
  ON hunter_runs(status);

-- 5. Add ebay_webhook_events to realtime publication so the print agent
-- can receive print requests instantaneously instead of rapid database polling
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE ebay_webhook_events;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
