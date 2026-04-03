# AlphaCard — Workspace Instructions

AlphaCard is a sports-card arbitrage engine. Python hunters discover undervalued eBay listings; a Next.js dashboard surfaces and manages the resulting leads.

## Architecture

```
Next.js 16 (App Router, TypeScript)   ← frontend + API routes
  └── Supabase (Postgres + RPC)       ← shared data layer
Python hunters (3 strategies)         ← eBay lead discovery
  └── eBay Browse/Find API            ← data source
```

Key files:
- `python/hunters/` — all three hunter algorithms (see Hunter Algorithms section)
- `python/utils/ebay_client.py` — OAuth2 + rate-limited eBay client (token bucket, 1 req/s floor, exponential backoff on 429)
- `python/utils/supabase_client.py` — typed DB helpers per table (`LeadsDB`, `CompsDB`, `WatchlistDB`, `HunterRunsDB`)
- `python/scripts/run_hunters.py` — CLI orchestrator to run all or specific hunters
- `app/types/index.ts` — canonical TypeScript type definitions
- `supabase/migrations/001_initial_schema.sql` — full schema reference
- `supabase/migrations/002_rpc_functions.sql` — Supabase RPC helpers

## Build & Run

```bash
# Frontend
npm install
npm run dev          # localhost:3000
npm run build

# Python (set up venv first)
cd python
python -m venv .venv
.venv\Scripts\activate          # Windows
pip install -r requirements.txt

# Run all hunters once
python -m scripts.run_hunters --once

# Run a specific hunter
python -m scripts.run_hunters --hunter typo
python -m scripts.run_hunters --hunter holo
python -m scripts.run_hunters --hunter stale

# Continuous scheduled mode
python -m scripts.run_hunters --schedule
```

Required env vars (copy `.env.example` → `.env`):
`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `EBAY_APP_ID`, `EBAY_CERT_ID`, `EBAY_DEV_ID`, `EBAY_ENVIRONMENT` (`PRODUCTION` or `SANDBOX`), `DISCORD_WEBHOOK_URL` (optional).

## Hunter Algorithms

Three independent hunters write to `raw_leads` via `LeadsDB.upsert_lead()` (dedupes on `ebay_item_id`). Each hunter records run metadata in `hunter_runs`.

### 1. Typo Hunter (`python/hunters/typo_hunter.py`)

Finds undervalued listings that standard searches miss because the title is misspelled.

**Signal source:** Watchlist players → `TypoGenerator` → eBay search per variant

**Variant generation methods (in priority order):**
1. `stored` — known typos from `watchlist.common_typos` (highest-value; boosts confidence +10)
2. `swap` — adjacent character transpositions (Levenshtein dist 1)
3. `drop` — dropped interior characters (dist 1, skips first/last char)
4. `spacing` — period removal, hyphen normalization, initial smashing, name reversal
5. `PARALLEL_TYPOS` dict — card-hobby-specific product-name typos (e.g. `prizm`→`prism`, `refractor`→`refactor`)

Up to `max_variants=8` are searched per player (stored typos first).

**Confidence scoring:** `comp_engine.confidence + 10` (if stored variant), capped at 100. Only persisted if `estimated_profit > MIN_PROFIT_THRESHOLD` env var (default $3).

**Guardrails:** `fuzz.partial_ratio(player_name, title) ≥ 60` required to prevent false positives.

### 2. Holo-Heuristic Engine (`python/hunters/holo_engine.py`)

Finds cards listed as "base" that are actually parallels/inserts — sellers fill out item specifics accurately but write lazy titles.

**Signal source:** Broad base-card queries (e.g. `"2024 Prizm football base rookie"`) → two-pronged detection

**Detection methods:**

*Method A — Specifics Mismatch (60 pts confidence):*
Fetches full item via `EbayClient.get_item()` and checks `localizedAspects`. If a field like `Parallel/Variety`, `Card Attributes`, or `Features` contains a parallel keyword not present in the title, it's a lead. This is where most alpha lives.

*Method B — Image Analysis (up to 38 pts additional):*
`ImageAnalyzer.analyze()` downloads the listing image and computes a composite `shininess` score (0–1):
- Color variance (std of all pixels) × 0.20 weight
- Saturation std (HSV) × 0.25 weight  
- Hot-spot ratio (pixels with saturation > 0.70) × 0.20 weight
- Border saturation (20px border region) × 0.20 weight
- Multi-modal histogram peaks (R+G+B) × 0.15 weight

Threshold: `shininess ≥ 0.35` triggers the flag. Confidence contribution = `shininess × 100 × 0.4`. Capped at 95 (image analysis is imperfect).

**`PARALLEL_KEYWORDS` dict** (`holo_engine.py` top-level) is the master keyword list covering high-value cards, Prizm parallels, refractor variants, numbered prints, and inserts. Update this dict to expand detection.

### 3. Stale Sniper (`python/hunters/stale_sniper.py`)

Finds motivated sellers with listings active > 14 days priced below 90% of comp median. Prioritizes Best Offer listings for lowball offers.

**Signal source:** Watchlist players + target sets/years → eBay `search_best_offer` + `search_fixed_price`

**Default parameters:** `min_days_active=14`, `max_price_pct=0.90`, `min_profit=$3.00`

**Lead scoring (0–100):**
- Discount from comp: up to 40 pts (`(1 - price/comp) × 100`, capped)
- Staleness: 5 (14d) / 12 (14-30d) / 20 (30-60d) / 25 (60d+)
- Best Offer: 20 pts vs 5 pts for fixed price
- Seller feedback: 15 pts (<50), 10 pts (<200), 5 pts (<1000), 2 pts (1000+)

**Offer price strategy:** 70% of ask (14-30d stale) → 60% (30-60d) → 50% (60d+), capped at 75% of comp.

## Comp Engine (`python/hunters/comp_engine.py`)

All three hunters call `CompEngine.calculate()` to price leads. It is **not** a hunter itself — it's a shared dependency.

**Pipeline:**
1. Check `sold_comps` Supabase cache
2. If < 3 cached comps, fetch eBay sold items (`search_sold_items`)
3. Remove outliers: floor at $0.99, then IQR method (1.5× interquartile range)
4. Return `CompResult` with median, mean, count, and confidence score

**Confidence score:** `count_score` (sigmoid to 50 pts at 15+ comps) + `variance_score` (50 pts if CV < 0.15, down to 5 pts if CV > 0.8). A score ≥ 65 is reliable.

## Profitability (`python/hunters/profitability.py`)

`ProfitCalculator.calculate()` is called after comp pricing to determine if a lead is worth pursuing.

**Shipping tiers:** ESE $0.63 (< $20), BMWT $4.50 ($20–$50), Tracked $8.00 (> $50)

**Death Zone ($20–$25):** ESE maxes out at $20 coverage; BMWT costs $3.87 more. Flag `death_zone=True` and recommend negotiating below $20 or above $25.

**eBay fees:** 13.25% FVF + $0.30 processing. Optional 3% promoted listings.

**Grading ROI:** If `(PSA_10_price - buy_price - PSA_cost - fees) > $50`, flag `grade_candidate=True`. PSA 10 multiplier default: 2.5×.

## Database Conventions

- `raw_leads` — every potential flip; deduped on `ebay_item_id`; status lifecycle: `new → reviewing → purchased/dismissed/listed/expired`
- `sold_comps` — pricing cache; stale comps are re-fetched when < 3 exist
- `watchlist` — players to hunt; `common_typos[]` and `target_sets[]` drive typo and stale searches
- `inventory` — purchased cards with grading and P&L tracking
- `hunter_runs` — observability; every hunt writes start/finish/fail records
- `v_hot_leads` — Supabase view; sorted by confidence for dashboard

GIN indexes on `player_name` and `title` (trigram) support fuzzy search. Use the view `v_hot_leads` for dashboard queries, not raw table scans.

## TypeScript / Next.js Conventions

- All types live in `app/types/index.ts` — do not duplicate type definitions
- Supabase client: use `supabaseAdmin` (service key, `app/lib/supabase.ts`) in API routes; never expose the service key to the browser
- API routes are in `app/api/` — follow existing `route.ts` pattern (NextRequest → NextResponse)
- Dashboard UI components: `app/(dashboard)/components/`; use Recharts for charts, Tailwind for styling; no CSS modules

## Pitfalls

- **eBay token:** Use `client_credentials` grant only. Do **not** set `EBAY_OAUTH_TOKEN` as an env var — it's a user token that expires and wastes a 401 on startup.
- **Rate limiter:** `EbayClient` enforces a 1 req/s floor and 5000 req/day cap. Do not bypass or create additional `EbayClient` instances per hunter; pass the shared instance via constructor injection.
- **Typo variant explosion:** `generate_variants` can produce hundreds of variants for long names. The `max_variants=8` cap in `hunt()` keeps API calls manageable — don't raise this casually.
- **Image analysis cost:** `HoloHeuristicEngine.hunt(analyze_images=True)` downloads one image per listing. Disable with `analyze_images=False` for faster dev runs or when eBay image URLs are unreliable.
- **Death Zone:** Cards priced $20–$25 have negative marginal economics vs ESE shipping. Always check `ProfitAnalysis.is_death_zone` before buying.
- **Comp cache:** `CompEngine` caches to `sold_comps` automatically. Re-running with `use_cache=True` (default) avoids redundant eBay calls — don't set `use_cache=False` in production loops.
