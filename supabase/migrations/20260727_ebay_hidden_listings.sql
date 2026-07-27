-- Listings manually hidden from the Listing Details page — excluded from
-- display and from every check (Title Check, Description Check, Duplicate
-- Check). Used for listings this tool can't manage (e.g. inventory-based
-- listings eBay itself flags as unsupported for bulk edit). Presence of a
-- row = hidden.
CREATE TABLE IF NOT EXISTS ebay_hidden_listings (
  item_id TEXT PRIMARY KEY,
  hidden_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
