-- ============================================================================
-- AlphaCard: Packing Slips
-- Adds ship-to address, order totals, and shipment/tracking columns to
-- ebay_sales (needed to render a packing slip), plus a storage bucket for
-- the generated PDFs and a table to make webhook notification processing
-- idempotent (eBay may redeliver the same notification).
-- Safe to re-run (uses IF NOT EXISTS / OR REPLACE everywhere)
-- ============================================================================

ALTER TABLE ebay_sales
  ADD COLUMN IF NOT EXISTS ship_to_name          TEXT,
  ADD COLUMN IF NOT EXISTS ship_to_street1        TEXT,
  ADD COLUMN IF NOT EXISTS ship_to_street2        TEXT,
  ADD COLUMN IF NOT EXISTS ship_to_city            TEXT,
  ADD COLUMN IF NOT EXISTS ship_to_state           TEXT,
  ADD COLUMN IF NOT EXISTS ship_to_zip             TEXT,
  ADD COLUMN IF NOT EXISTS ship_to_country         TEXT,
  ADD COLUMN IF NOT EXISTS ship_to_phone           TEXT,
  ADD COLUMN IF NOT EXISTS sales_record_number     TEXT,
  ADD COLUMN IF NOT EXISTS shipping_service        TEXT,
  ADD COLUMN IF NOT EXISTS order_subtotal          NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS order_shipping_cost     NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS order_tax               NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS order_total             NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS tracking_number         TEXT,
  ADD COLUMN IF NOT EXISTS carrier                 TEXT,
  ADD COLUMN IF NOT EXISTS shipped_at              TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS packing_slip_generated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS packing_slip_url        TEXT;

-- Tracks processed eBay notification IDs so a redelivered webhook payload
-- doesn't regenerate/re-upload the same packing slip twice.
CREATE TABLE IF NOT EXISTS ebay_webhook_events (
  notification_id TEXT PRIMARY KEY,
  topic            TEXT NOT NULL,
  order_number     TEXT,
  received_at      TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE ebay_webhook_events ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Service role full access" ON ebay_webhook_events FOR ALL
    USING (auth.role() = 'service_role');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Storage bucket for generated packing slip PDFs
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'packing-slips',
  'packing-slips',
  true,
  5242880, -- 5 MB
  ARRAY['application/pdf']
)
ON CONFLICT (id) DO NOTHING;

DO $$ BEGIN
  CREATE POLICY "packing_slips_public_read"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'packing-slips');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "packing_slips_service_upload"
    ON storage.objects FOR INSERT
    WITH CHECK (bucket_id = 'packing-slips');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "packing_slips_service_update"
    ON storage.objects FOR UPDATE
    USING (bucket_id = 'packing-slips');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
