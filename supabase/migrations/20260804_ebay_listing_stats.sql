-- View count (HitCount) and watcher count (WatchCount) for each listing,
-- fetched via the same GetItem call already used for item specifics.
-- Unlike specifics (cached indefinitely until a revision), these change
-- constantly, so stats_updated_at lets /api/ebay/listing-details treat them
-- as stale after a TTL and re-fetch, instead of caching them forever.
ALTER TABLE ebay_item_specifics
  ADD COLUMN IF NOT EXISTS hit_count INT,
  ADD COLUMN IF NOT EXISTS watch_count INT,
  ADD COLUMN IF NOT EXISTS stats_updated_at TIMESTAMPTZ;
