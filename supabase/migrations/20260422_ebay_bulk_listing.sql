-- Bulk eBay Listing Tables
-- Run this in Supabase SQL Editor

-- Job tracking table
CREATE TABLE IF NOT EXISTS ebay_listing_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  total_items INT NOT NULL DEFAULT 0,
  listed_count INT NOT NULL DEFAULT 0,
  failed_count INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- Individual listing items
CREATE TABLE IF NOT EXISTS ebay_listing_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID REFERENCES ebay_listing_jobs(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  player_name TEXT,
  card_year INT,
  card_set TEXT,
  card_number TEXT,
  sport TEXT DEFAULT 'mlb',
  condition TEXT DEFAULT 'ungraded',
  grader TEXT,
  grade TEXT,
  cert_number TEXT,
  price DECIMAL(10,2) NOT NULL,
  quantity INT DEFAULT 1,
  image_urls TEXT[],
  ebay_item_id TEXT,
  ebay_listing_url TEXT,
  status TEXT DEFAULT 'pending',
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Index for fast job lookups
CREATE INDEX IF NOT EXISTS idx_listing_items_job_id ON ebay_listing_items(job_id);
CREATE INDEX IF NOT EXISTS idx_listing_jobs_status ON ebay_listing_jobs(status);
