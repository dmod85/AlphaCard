---
name: Hunter Debug
description: Diagnose why a hunter run produced 0 or very few leads. Queries hunter_runs and raw_leads and returns a structured diagnosis.
---

# Hunter Debug

Diagnose why a specific hunter run produced 0 or very few leads.

## Arguments

- `hunter`: Which hunter to investigate — `typo`, `holo`, or `stale` (default: most recent run across all hunters)
- `run_id`: Specific run UUID to inspect (optional; defaults to the most recent run of the given hunter)

## Steps

1. **Pull the run record** from `hunter_runs`:
   - `started_at`, `finished_at`, `status` (`running` / `finished` / `failed`)
   - `leads_found`, `items_scanned`, `errors`
   - `error_log` (JSON array of `{player, variant, error}` objects for typo/stale; raw error string for holo)
   - `config` (the constructor parameters used for that run)

2. **Pull raw_leads written by this run** — filter `hunter_source = <hunter>` and `discovered_at` within the run window. Show:
   - Count by `status`
   - Min/max/avg `confidence`
   - Count where `estimated_profit IS NULL` (comp failures)
   - Any leads where `death_zone = TRUE`

3. **Check sold_comps cache health** — for every player that produced 0 leads, count cached comps. Flag players with < 3 comps (comp engine falls back to eBay live fetch; failures here silently drop leads).

4. **Check eBay rate limiter** — look for errors containing `429`, `quota`, or `rate` in the error_log. If present, note that `EbayClient` backs off exponentially but will skip requests after 5 retries.

5. **Synthesize a diagnosis** in this structure:

```
## Run Summary
- Hunter:        <hunter_type>
- Run ID:        <uuid>
- Status:        <status>
- Duration:      <Xm Ys>
- Items scanned: <N>
- Leads found:   <N>
- Errors:        <N>

## Root Cause(s)
1. <Most likely cause with evidence>
2. <Secondary cause if present>

## Recommended Actions
- [ ] <Actionable fix #1>
- [ ] <Actionable fix #2>
```

## Common Root Causes by Hunter

**Typo Hunter — 0 leads:**
- `items_scanned = 0` → eBay returned nothing for all variants; check watchlist has active players with `target_sets` set
- `errors` high → likely 429 rate limit; check token bucket exhaustion
- `items_scanned > 0` but `leads_found = 0` → all listings failed `fuzz.partial_ratio ≥ 60` check, OR all comps returned `estimated_profit < MIN_PROFIT_THRESHOLD` ($3 default)
- All leads have `estimated_profit IS NULL` → CompEngine returned None for every player; check `sold_comps` cache and eBay sold-items connectivity

**Holo-Heuristic Engine — 0 leads:**
- `items_scanned > 0` but `leads_found = 0` → all titles already contained a parallel keyword (search is pulling correctly labelled listings); broaden queries or update `PARALLEL_KEYWORDS`
- `get_item()` calls all failing → Full item fetch (needed for `localizedAspects`) silently skipped; eBay item endpoint may require different scope
- Image analysis disabled (`analyze_images=False`) and no `localizedAspects` mismatches → only metadata path available; confirm seller category compliance

**Stale Sniper — 0 leads:**
- `items_scanned > 0` but all filtered by `days_active < min_days_active` → listings returned are fresh; search query too narrow (all players have no `target_sets`)
- All pass days filter but `price / comp > max_price_pct` → sellers have repriced to comp; nothing stale AND underpriced simultaneously
- `best_offer` listings returning 0 → `search_best_offer` eBay filter may be returning BIN-only results; verify `itemFilter` param in `ebay_client.py`
