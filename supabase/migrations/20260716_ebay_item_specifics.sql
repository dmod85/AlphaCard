-- Cache of eBay item specifics (fetched via GetItem), so the Listing Details
-- page doesn't re-spend a GetItem call per listing on every page load/refresh.
-- Rows are refreshed whenever an item's specifics are revised.
CREATE TABLE IF NOT EXISTS ebay_item_specifics (
  item_id TEXT PRIMARY KEY,
  specifics JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
