-- Listings whose title has been manually overridden and should be excluded
-- from the Listing Details "Title Check" panel, which otherwise flags any
-- title that doesn't match the generated Set/Player/Card#/Parallel/Team
-- template as needing an update. Presence of a row = locked.
CREATE TABLE IF NOT EXISTS ebay_title_locks (
  item_id TEXT PRIMARY KEY,
  locked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
