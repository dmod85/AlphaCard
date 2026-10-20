-- ============================================================================
-- AlphaCard: Drop Hunter Schema & Realtime Subscriptions
-- Permanently removes hunter-related tables, views, RPCs, and publications
-- to stop excessive disk I/O and free up storage.
-- ============================================================================

-- 1. Remove tables from realtime publication to stop Postgres CDC / WAL write amplification
DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime DROP TABLE raw_leads;
  EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime DROP TABLE hunter_runs;
  EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
  END;
END $$;

-- 2. Drop dependent views
DROP VIEW IF EXISTS v_hot_leads CASCADE;
DROP VIEW IF EXISTS v_hunter_performance CASCADE;

-- 3. Drop hunter-specific RPC functions
DROP FUNCTION IF EXISTS search_leads CASCADE;
DROP FUNCTION IF EXISTS dismiss_stale_leads CASCADE;
DROP FUNCTION IF EXISTS purchase_lead CASCADE;
DROP FUNCTION IF EXISTS check_death_zone CASCADE;
DROP FUNCTION IF EXISTS auto_shipping_tier CASCADE;
DROP FUNCTION IF EXISTS calc_profit CASCADE;
DROP FUNCTION IF EXISTS check_grading_candidate CASCADE;

-- 4. Remove foreign key on inventory (lead_id) so we can drop raw_leads safely
DO $$
BEGIN
  ALTER TABLE inventory DROP CONSTRAINT IF EXISTS inventory_lead_id_fkey;
  ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_lead_id_fkey;
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL;
END $$;

-- 5. Drop hunter tables (permanently removes rows & associated indexes)
DROP TABLE IF EXISTS sold_comps CASCADE;
DROP TABLE IF EXISTS raw_leads CASCADE;
DROP TABLE IF EXISTS hunter_runs CASCADE;
DROP TABLE IF EXISTS player_watchlist CASCADE;

-- 6. Drop unused enum types
DROP TYPE IF EXISTS lead_status CASCADE;
DROP TYPE IF EXISTS hunter_source CASCADE;
DROP TYPE IF EXISTS shipping_tier CASCADE;
DROP TYPE IF EXISTS grading_status CASCADE;
DROP TYPE IF EXISTS card_sport CASCADE;
