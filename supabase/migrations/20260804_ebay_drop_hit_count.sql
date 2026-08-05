-- HitCount (page views) turned out to be a dead eBay Trading API field for
-- modern listings — it's only populated when a listing's old "hit counter"
-- display style is explicitly enabled (off by default), and eBay has flagged
-- the whole feature for decommission. Dropping the column; watch_count and
-- stats_updated_at (added in 20260804_ebay_listing_stats.sql) remain in use.
ALTER TABLE ebay_item_specifics
  DROP COLUMN IF EXISTS hit_count;
