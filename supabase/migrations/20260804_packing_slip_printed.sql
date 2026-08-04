-- ============================================================================
-- AlphaCard: Packing Slip Auto-Print
-- Tracks which orders have already been sent to the local print agent, and
-- enables Supabase Realtime on ebay_sales so the agent hears about a new
-- packing slip (packing_slip_url set) within ~1s instead of polling.
-- Safe to re-run.
-- ============================================================================

ALTER TABLE ebay_sales
  ADD COLUMN IF NOT EXISTS printed_at TIMESTAMPTZ;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE ebay_sales;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
