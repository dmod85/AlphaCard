---
applyTo: python/hunters/**
---

# Hunter Implementation Conventions

Rules that apply whenever you create or modify code in `python/hunters/`.

## Shared Dependencies — Always Inject, Never Instantiate

Every hunter receives `EbayClient`, `CompEngine`, and DB helpers through constructor parameters. Never create a new `EbayClient()` inside a hunter method — the shared instance carries the rate-limiter state and token cache. Violation wastes an OAuth round-trip on every call and bypasses the 5000 req/day cap.

```python
# CORRECT — accept via constructor, fall back to default only at __init__ boundary
def __init__(self, ebay: Optional[EbayClient] = None, ...):
    self.ebay = ebay or EbayClient()

# WRONG — creates a fresh client mid-hunt, destroying rate-limiter state
def hunt(self):
    client = EbayClient()   # ← never do this
```

The orchestrator (`run_hunters.py`) creates one `EbayClient` and passes it to all three hunters. Maintain that contract.

## Lead Persistence — Use `upsert_lead()`, Never Raw Inserts

Always call `self.leads_db.upsert_lead(lead)` or `upsert_leads_batch(leads)`. The upsert dedupes on `ebay_item_id`; raw inserts will raise a unique-constraint violation on re-runs.

```python
# CORRECT
self.leads_db.upsert_lead(lead_dict)

# WRONG
self.db.table("raw_leads").insert(lead_dict).execute()
```

## Profit Gate — Check `MIN_PROFIT_THRESHOLD` Before Writing

Only persist a lead if it clears the minimum profit threshold. Read from env:

```python
import os
min_profit = float(os.environ.get("MIN_PROFIT_THRESHOLD", 3))
if lead.get("estimated_profit", 0) > min_profit:
    self.leads_db.upsert_lead(lead)
```

Never hardcode the threshold value.

## Run Observability — Wrap Every `hunt()` With `start_run` / `finish_run` / `fail_run`

```python
run_id = self.runs_db.start_run("hunter_name", config={...})
try:
    ...
    self.runs_db.finish_run(run_id, leads_found, items_scanned, errors, error_log)
except Exception as e:
    self.runs_db.fail_run(run_id, str(e))
    raise   # re-raise so the orchestrator can log it
```

Never swallow the exception after `fail_run`. The orchestrator catches it and records it in the summary.

## CompEngine — Use Cache By Default

Always call `CompEngine.calculate()` with `use_cache=True` (the default). Never pass `use_cache=False` in production loops — it will hammer the eBay sold-items endpoint for every listing and exhaust the daily quota.

```python
comp = self.comp_engine.calculate(
    player_name=name,
    card_set=card_set,
    # use_cache=True is the default — don't override it
)
```

## Confidence Scores

- Cap all confidence values at `min(value, 95)` for image-derived scores and `min(value, 100)` for metadata-derived scores.
- A score below 40 should not be persisted unless there's a specific reason (e.g., stored typo with no comp data).
- The `holo_heuristic` cap is 95 (image analysis is imperfect by design).

## `PARALLEL_KEYWORDS` (Holo Engine)

The master keyword dict lives at the top of `holo_engine.py`. When adding keywords:
- Add to the most specific group (`high_value`, `prizm_parallels`, `refractor_parallels`, `numbered`, `inserts`).
- Keep all values lowercase — comparisons are done with `.lower()` on both sides.
- Do not duplicate keywords across groups; `ALL_PARALLEL_KEYWORDS` is built by flattening all groups.

## Typo Variant Cap

`TypoGenerator.generate_variants()` can produce hundreds of variants for long names. The `max_variants=8` cap in `TypoHunter.hunt()` keeps eBay API calls manageable. Raising it multiplies scan time linearly — consider adding stored typos to `watchlist.common_typos` instead.

## Fuzzy Match Guard (Typo Hunter)

After searching a typo variant, every returned listing must pass:

```python
fuzz.partial_ratio(player_name.lower(), title.lower()) >= 60
```

Do not lower this threshold without also tightening the search query. False positives from unrelated listings pollute `raw_leads` and waste comp-engine calls.

## Error Handling

- Per-item errors (failed `get_item()` call, image download timeout, comp failure) should be caught, logged at DEBUG/ERROR, and counted in `errors`. **Do not abort the entire hunt.**
- Fatal errors (DB connection failure, credential error) should propagate after calling `fail_run`.

```python
for item in items:
    try:
        ...
    except Exception as e:
        errors += 1
        error_log.append({"item_id": item.get("itemId"), "error": str(e)})
        logger.error(f"Item processing failed: {e}")
        continue   # keep going
```
