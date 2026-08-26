-- ============================================================================
-- AlphaCard: Per-sale selling costs + operating expenses + P&L defaults
-- Safe to re-run (IF NOT EXISTS / OR REPLACE)
-- ============================================================================

ALTER TABLE ebay_sales
  ADD COLUMN IF NOT EXISTS ebay_fee          NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS advertising_fee   NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS shipping_cost     NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS supplies_cost     NUMERIC(10, 2);

-- Logged expenses that aren't tied to a single sale (Promoted Listings
-- invoices, bulk sleeves/top-loaders, extra postage, etc.)
CREATE TABLE IF NOT EXISTS operating_expenses (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  expense_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  category      TEXT NOT NULL CHECK (category IN ('advertising', 'supplies', 'shipping', 'ebay_fees', 'other')),
  amount        NUMERIC(10, 2) NOT NULL DEFAULT 0,
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_operating_expenses_date ON operating_expenses(expense_date DESC);
CREATE INDEX IF NOT EXISTS idx_operating_expenses_cat  ON operating_expenses(category);

ALTER TABLE operating_expenses ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Service role full access" ON operating_expenses FOR ALL
    USING (auth.role() = 'service_role');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_operating_expenses_updated
    BEFORE UPDATE ON operating_expenses
    FOR EACH ROW EXECUTE FUNCTION update_modified_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Single-row defaults used when a sale is synced without an explicit cost.
CREATE TABLE IF NOT EXISTS pnl_settings (
  id                      INTEGER PRIMARY KEY CHECK (id = 1),
  default_shipping_cost   NUMERIC(10, 2) NOT NULL DEFAULT 0.63,
  default_supplies_cost   NUMERIC(10, 2) NOT NULL DEFAULT 0,
  default_fee_rate        NUMERIC(6, 4)  NOT NULL DEFAULT 0.1325,
  default_processing_fee  NUMERIC(10, 2) NOT NULL DEFAULT 0.30,
  default_ad_rate         NUMERIC(6, 4)  NOT NULL DEFAULT 0,
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO pnl_settings (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE pnl_settings ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Service role full access" ON pnl_settings FOR ALL
    USING (auth.role() = 'service_role');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
