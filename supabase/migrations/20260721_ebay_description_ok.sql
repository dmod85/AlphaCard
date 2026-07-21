-- Add description_ok flag to ebay_item_specifics.
-- True  = description was last written by our ReviseItem call (matches template).
-- False = unknown / never revised / stale.
-- This lets the Description Check panel work from the Supabase cache instead of
-- re-fetching live HTML from eBay's GetSellerList on every page load.
ALTER TABLE ebay_item_specifics
  ADD COLUMN IF NOT EXISTS description_ok boolean NOT NULL DEFAULT false;
