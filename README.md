# AlphaCard — Sourcing & Resale Engine

> Automated identification, valuation, and listing of sports cards with a focus on misidentified parallels and undervalued "stale" listings.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  NEXT.JS DASHBOARD               │
│         (Vercel / localhost:3000)                 │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │
│  │ Lead Feed│ │ Inventory│ │ Analytics/Charts │ │
│  └────┬─────┘ └────┬─────┘ └────────┬─────────┘ │
│       └─────────────┼────────────────┘           │
│                     │ API Routes                 │
└─────────────────────┼───────────────────────────┘
                      │
              ┌───────▼────────┐
              │   SUPABASE     │
              │  ┌───────────┐ │
              │  │ raw_leads │ │
              │  │ sold_comps│ │
              │  │ inventory │ │
              │  │ watchlist │ │
              │  └───────────┘ │
              └───────▲────────┘
                      │
         ┌────────────┼────────────────┐
         │      PYTHON HUNTERS          │
         │  ┌──────────────────────┐   │
         │  │ 🔤 Typo Hunter       │   │
         │  │ 🌈 Holo-Heuristic    │   │
         │  │ 🎯 Stale Sniper      │   │
         │  │ 📊 Comp Engine       │   │
         │  │ 💰 Profit Calculator │   │
         │  └──────────┬───────────┘   │
         │             │               │
         │     ┌───────▼──────┐        │
         │     │  eBay API    │        │
         │     │ (Browse/Find)│        │
         │     └──────────────┘        │
         │             │               │
         │     ┌───────▼──────┐        │
         │     │ Notifications│        │
         │     │ Discord/Push │        │
         │     └──────────────┘        │
         └─────────────────────────────┘
```

## Quick Start

### 1. Clone & Install

```bash
git clone <your-repo>
cd alphacard

# Frontend
npm install

# Python
cd python
python -m venv .venv
source .venv/bin/activate  # or .venv\Scripts\activate on Windows
pip install -r requirements.txt
```

### 2. Configure Environment

```bash
cp .env.example .env
# Fill in your Supabase, eBay, and notification credentials
```

### 3. Set Up Supabase

1. Create a new project at [supabase.com](https://supabase.com)
2. Go to SQL Editor
3. Run the migration: `supabase/migrations/001_initial_schema.sql`
4. Copy your project URL and keys to `.env`

### 4. Set Up eBay Developer Account

1. Register at [developer.ebay.com](https://developer.ebay.com)
2. Create a production keyset
3. Generate an OAuth token using the client credentials flow
4. Add keys to `.env`

### 5. Run

```bash
# Start the dashboard
npm run dev
# → http://localhost:3000

# Run hunters (one-time)
cd python
python -m scripts.run_hunters --once

# Run hunters on schedule (every 15 min)
python -m scripts.run_hunters --schedule --interval 15

# Run a specific hunter
python -m scripts.run_hunters --hunter typo
python -m scripts.run_hunters --hunter holo
python -m scripts.run_hunters --hunter stale
```

## The Three Hunters

### 🔤 Typo Hunter
Finds listings with misspelled player names that standard searches miss.
- Generates typo variants: transpositions, drops, phonetic swaps, spacing
- Uses stored common misspellings from the watchlist
- Fuzzy matches results back to verify relevance

### 🌈 Holo-Heuristic Engine
Identifies parallel cards mislisted as base cards.
- **Text analysis**: Checks item specifics for parallel keywords missing from the title
- **Image analysis**: Pixel-variance detection for "shininess" — color saturation, hot spots, border analysis, histogram peaks

### 🎯 Stale Sniper
Flags underpriced listings from motivated sellers.
- Targets listings active >14 days priced below 90% of median comp
- Prioritizes Best Offer listings (calculates optimal offer price)
- Scores seller sophistication (lower feedback = better deals)

## Profitability Engine

Every lead is automatically analyzed:

| Metric | How It's Calculated |
|--------|-------------------|
| eBay Fees | 13.25% FVF + $0.30 processing |
| Shipping | Auto-assigned: ESE (<$20), BMWT ($20-50), Tracked ($50+) |
| Death Zone | ⚠️ $20-$25 cards flagged — BMWT shipping eats profit |
| Grading ROI | If PSA 10 multiplier yields >$50 profit, card is flagged |
| Net Profit | Sale price - buy price - fees - shipping |

## Notifications

- **Discord**: All new leads with embedded cards showing price, comp, profit, and direct eBay link
- **Pushover**: High-priority phone push for BIN deals with >$10 profit

## Deploy to Vercel

```bash
npm i -g vercel
vercel --prod
```

Set environment variables in Vercel dashboard:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_KEY`

## Project Structure

```
alphacard/
├── app/                    # Next.js App Router
│   ├── api/               # API routes
│   │   ├── leads/         # Lead CRUD + stats
│   │   └── inventory/     # Inventory management
│   ├── (dashboard)/       # Dashboard page
│   │   └── page.tsx       # Main dashboard component
│   ├── lib/               # Supabase client
│   ├── types/             # TypeScript types
│   ├── styles/            # Global CSS
│   └── layout.tsx         # Root layout
├── python/
│   ├── hunters/
│   │   ├── comp_engine.py      # Median pricing + outlier removal
│   │   ├── typo_hunter.py      # Misspelling searcher
│   │   ├── holo_engine.py      # Image analysis + metadata
│   │   ├── stale_sniper.py     # Aged listing finder
│   │   └── profitability.py    # Full P&L calculator
│   ├── utils/
│   │   ├── ebay_client.py      # eBay API with OAuth + backoff
│   │   ├── supabase_client.py  # DB operations
│   │   └── notifications.py    # Discord + Pushover
│   └── scripts/
│       └── run_hunters.py      # CLI orchestrator + scheduler
├── supabase/
│   └── migrations/
│       └── 001_initial_schema.sql  # Full DB schema with triggers
├── .env.example
├── package.json
├── tailwind.config.js
├── tsconfig.json
└── README.md
```

## Key Design Decisions

1. **Supabase triggers handle business logic** — death zone detection, shipping tier assignment, profit calculation, and grading checks all happen at the database level via triggers, keeping the Python code focused on hunting.

2. **IQR outlier removal** — The comp engine uses interquartile range filtering to strip shill bids and pricing errors, producing reliable median valuations.

3. **Exponential backoff** — All eBay API calls use retry logic with exponential backoff to stay within rate limits.

4. **Confidence scoring** — Every lead gets a composite confidence score (0-100) based on comp count, price variance, and detection method quality.

## Cost

| Service | Tier | Cost |
|---------|------|------|
| Supabase | Free | $0 |
| eBay API | Developer | $0 |
| Vercel | Hobby | $0 |
| Python | Local execution | $0 |
| Discord | Free webhook | $0 |
| Pushover | One-time | $5 |

## License

Private. Not for distribution.
