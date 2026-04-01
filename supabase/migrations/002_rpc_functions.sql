-- ============================================================================
-- AlphaCard Migration 002: RPC Functions & Realtime
-- ============================================================================

-- Enable realtime on key tables
ALTER PUBLICATION supabase_realtime ADD TABLE raw_leads;
ALTER PUBLICATION supabase_realtime ADD TABLE hunter_runs;
ALTER PUBLICATION supabase_realtime ADD TABLE inventory;

-- ============================================================================
-- RPC: Dashboard summary (single call for all stats)
-- ============================================================================

CREATE OR REPLACE FUNCTION get_dashboard_summary()
RETURNS JSON AS $$
DECLARE
  result JSON;
BEGIN
  SELECT json_build_object(
    'new_leads', (SELECT COUNT(*) FROM raw_leads WHERE status = 'new'),
    'total_leads', (SELECT COUNT(*) FROM raw_leads),
    'potential_profit', (
      SELECT COALESCE(SUM(estimated_profit), 0)
      FROM raw_leads
      WHERE status = 'new' AND estimated_profit > 0
    ),
    'avg_confidence', (
      SELECT COALESCE(ROUND(AVG(confidence)::numeric, 1), 0)
      FROM raw_leads
      WHERE status = 'new'
    ),
    'death_zone_count', (
      SELECT COUNT(*) FROM raw_leads
      WHERE status = 'new' AND death_zone = TRUE
    ),
    'grade_candidates', (
      SELECT COUNT(*) FROM raw_leads
      WHERE status = 'new' AND grade_candidate = TRUE
    ),
    'purchased_today', (
      SELECT COUNT(*) FROM raw_leads
      WHERE status = 'purchased'
        AND reviewed_at >= CURRENT_DATE
    ),
    'active_inventory', (
      SELECT COUNT(*) FROM inventory
      WHERE status NOT IN ('sold', 'returned')
    ),
    'inventory_value', (
      SELECT COALESCE(SUM(total_cost), 0) FROM inventory
      WHERE status NOT IN ('sold', 'returned')
    ),
    'total_profit', (
      SELECT COALESCE(SUM(net_profit), 0) FROM inventory
      WHERE status = 'sold'
    )
  ) INTO result;

  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- RPC: Smart lead search with fuzzy matching
-- ============================================================================

CREATE OR REPLACE FUNCTION search_leads(
  search_query TEXT,
  status_filter TEXT DEFAULT 'new',
  sport_filter TEXT DEFAULT NULL,
  hunter_filter TEXT DEFAULT NULL,
  min_profit NUMERIC DEFAULT NULL,
  limit_count INTEGER DEFAULT 50,
  offset_count INTEGER DEFAULT 0
)
RETURNS TABLE (
  id UUID,
  ebay_item_id TEXT,
  title TEXT,
  player_name TEXT,
  sport card_sport,
  current_price NUMERIC,
  median_comp NUMERIC,
  estimated_profit NUMERIC,
  roi_pct NUMERIC,
  confidence NUMERIC,
  hunter_source hunter_source,
  alpha_reason TEXT,
  shipping_tier shipping_tier,
  death_zone BOOLEAN,
  grade_candidate BOOLEAN,
  best_offer BOOLEAN,
  buy_it_now BOOLEAN,
  days_active INTEGER,
  image_url TEXT,
  item_url TEXT,
  status lead_status,
  discovered_at TIMESTAMPTZ,
  similarity REAL
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    rl.id, rl.ebay_item_id, rl.title, rl.player_name,
    rl.sport, rl.current_price, rl.median_comp,
    rl.estimated_profit, rl.roi_pct, rl.confidence,
    rl.hunter_source, rl.alpha_reason, rl.shipping_tier,
    rl.death_zone, rl.grade_candidate, rl.best_offer,
    rl.buy_it_now, rl.days_active, rl.image_url, rl.item_url,
    rl.status, rl.discovered_at,
    CASE
      WHEN search_query IS NOT NULL AND search_query != ''
      THEN GREATEST(
        similarity(rl.title, search_query),
        similarity(COALESCE(rl.player_name, ''), search_query)
      )
      ELSE 1.0
    END AS similarity
  FROM raw_leads rl
  WHERE
    (status_filter IS NULL OR rl.status = status_filter::lead_status)
    AND (sport_filter IS NULL OR rl.sport = sport_filter::card_sport)
    AND (hunter_filter IS NULL OR rl.hunter_source = hunter_filter::hunter_source)
    AND (min_profit IS NULL OR rl.estimated_profit >= min_profit)
    AND (
      search_query IS NULL
      OR search_query = ''
      OR rl.title ILIKE '%' || search_query || '%'
      OR rl.player_name ILIKE '%' || search_query || '%'
      OR similarity(rl.title, search_query) > 0.2
      OR similarity(COALESCE(rl.player_name, ''), search_query) > 0.3
    )
  ORDER BY
    CASE WHEN search_query IS NOT NULL AND search_query != ''
      THEN GREATEST(
        similarity(rl.title, search_query),
        similarity(COALESCE(rl.player_name, ''), search_query)
      )
      ELSE rl.confidence
    END DESC
  LIMIT limit_count
  OFFSET offset_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- RPC: Batch dismiss old leads
-- ============================================================================

CREATE OR REPLACE FUNCTION dismiss_stale_leads(days_old INTEGER DEFAULT 7)
RETURNS INTEGER AS $$
DECLARE
  dismissed_count INTEGER;
BEGIN
  UPDATE raw_leads
  SET status = 'expired', reviewed_at = NOW()
  WHERE status = 'new'
    AND discovered_at < NOW() - (days_old || ' days')::INTERVAL;

  GET DIAGNOSTICS dismissed_count = ROW_COUNT;
  RETURN dismissed_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- RPC: Move lead to inventory (purchase flow)
-- ============================================================================

CREATE OR REPLACE FUNCTION purchase_lead(
  lead_id UUID,
  actual_price NUMERIC DEFAULT NULL,
  shipping_paid NUMERIC DEFAULT 0
)
RETURNS UUID AS $$
DECLARE
  the_lead raw_leads%ROWTYPE;
  new_card_id UUID;
BEGIN
  -- Get the lead
  SELECT * INTO the_lead FROM raw_leads WHERE id = lead_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lead not found: %', lead_id;
  END IF;

  -- Update lead status
  UPDATE raw_leads
  SET status = 'purchased', reviewed_at = NOW()
  WHERE id = lead_id;

  -- Create inventory record
  INSERT INTO inventory (
    lead_id, ebay_item_id, player_name, card_year, card_set,
    card_number, parallel_type, sport, purchase_price, shipping_paid
  ) VALUES (
    lead_id,
    the_lead.ebay_item_id,
    the_lead.player_name,
    the_lead.card_year,
    the_lead.card_set,
    the_lead.card_number,
    the_lead.parallel_type,
    the_lead.sport,
    COALESCE(actual_price, the_lead.current_price),
    shipping_paid
  )
  RETURNING id INTO new_card_id;

  RETURN new_card_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
