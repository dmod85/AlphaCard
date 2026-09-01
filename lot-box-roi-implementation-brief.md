# Lot / Box ROI — Implementation Brief

Hand this to the coding agent. It summarizes how inventory ROI should work after the owner discussion. Implement against the existing box/lot dashboard (columns: Date, Year, Brand, Series, Sport, Box Size, Cost, # Cards, Sold, Total Sales, ROI, SKU). Grouped parent rows already sum child purchases (e.g. x2, x6, x22).

## Problem

ROI is currently:

```
ROI = (Total Sales − Full Purchase Cost) / Full Purchase Cost
```

That is **lot-to-date only**. A box of 40 that lists 3 cards stays deeply negative until almost everything sells. Same formula is used for ripped boxes and for purchased lots. Pack/box card count is used as `# Cards`, not “cards we actually intend to sell.”

Owner wants running performance **as cards sell**, without waiting to recoup the whole buy.

## Core model

Every purchase is a **Pool** (one SKU / lot / box / grouped parent).

A pool has:

- `purchase_cost` (what was paid, including inbound ship/tax)
- `sellable_qty` — cards that will be listed or sold as bulk tied to this pool
- `sold_qty`
- `total_net_sales` (after fees + outbound ship)
- per-card `allocated_cost` (basis)

Do **not** use sealed pack count as `sellable_qty` unless every card will be sold.

### Reconstructing `# Cards` on old rows

Owner often does not remember how many from a box were listed.

```
sellable_qty = sold_on_this_sku + still_listed_with_this_sku + still_on_hand_AND_will_be_sold
```

Exclude PC / giveaway / forgotten junk. Bulk crap counts only if it will be sold (singles or a bulk dump tied to this SKU).

`purchase_cost` and `total_sales` stay unchanged when `# Cards` is corrected. Only the progress bar and per-card basis change.

## Two ROI numbers (show both)

### 1. Lot-to-date ROI (keep current)

```
lot_to_date_roi = (total_net_sales − purchase_cost) / purchase_cost
recovered = total_net_sales / purchase_cost
remaining_cost = purchase_cost − cost_of_sold
```

Answer: “Have I recouped this buy yet?”
Stays negative until cash in ≥ cash out. This is correct and must remain visible.

### 2. Realized ROI (add this)

```
cost_of_sold = sum(allocated_cost of sold cards)
realized_profit = total_net_sales − cost_of_sold
realized_roi = realized_profit / cost_of_sold     # blank if cost_of_sold = 0
```

Answer: “Are the cards I am selling working?”
Can go green on the first good sale.

Dashboard should show both, e.g.

`Sales $41.74 | Realized +18% | Lot-to-date −68% | 9 sold / 12 sellable`

Do not replace lot-to-date with realized. Owner uses lot-to-date to know if the purchase is in the black.

## Cost allocation

### Equal split (default)

Use when cards in the pool are the same tier (same type of singles, same expected value).

```
allocated_cost = purchase_cost / sellable_qty
```

Example: two similar lots, $20 for 10 and $10 for 5, lumped because they cannot tell which sale came from which:

```
pool cost $30 / 15 cards = $2.00 each
```

Pooling is allowed only for same-tier product. Owner explicitly wants this when source lot cannot be tracked at sale time.

### Weighted / hits (required when values differ)

“Hits” = cards worth clearly more than the rest.

Do **not** equal-split a mixed pool. Equal split over-costs bulk and under-costs hits. Selling the hit first inflates realized ROI and leaves leftover bulk carrying most of the basis.

Value-weight:

```
card_basis = purchase_cost × (card_est_value / sum_est_value_of_sellable)
```

Example: lot cost $30; values $50, $5, $5 (total $60):

- Hit basis = 50/60 × $30 = $25.00
- Each small = 5/60 × $30 = $2.50

### Residual method for ripped boxes (preferred for boxes)

Box/blaster/mega: only a couple of cards get listed.

```
bulk_recovery = expected net from leftovers sold as one bulk lot (or $0 if never selling them)
hit_pool_cost = purchase_cost − bulk_recovery
```

Split `hit_pool_cost` across listed/sellable hits by relative value.

Example: box $80, two listers worth $50 and $20, bulk maybe $10:

- Hits absorb $70
- $50 card basis = 50/70 × $70 = $50
- $20 card basis = 20/70 × $70 = $20
- One leftover bulk row at $10 (not 38 rows)

If leftovers will never be sold: `bulk_recovery = 0`, hits carry the full box cost. Higher basis on hits, pool closes when those hits sell.

**Never** put equal cost on all 40 pack cards if only 2–5 will be sold. That is why rows like Chrome MLS `1/28` at −93% look dead.

## Boxes vs lots

Same engine. Difference is only default allocation:

| Type | `# Cards` default | Allocation default |
|---|---|---|
| Purchased lot of similar singles | cards in the lot | Equal split |
| Several similar mini-lots, source unknown at sale | sum of cards | Equal split into one pooled SKU |
| Mixed lot (one hit + cheap cards) | cards that will sell | Weighted or residual |
| Ripped box / blaster / mega | cards listed + bulk row if bulk will sell | Residual: leftovers get scrap value, hits get the rest |

Do not special-case ROI math for boxes.

## What to change in the UI

Existing parent/child SKU grouping stays.

Per pool row add:

- `Sellable qty` (editable; this is `# Cards` after the rule above)
- `Sold qty` (already have)
- `Cost of sold`
- `Remaining cost`
- `Realized profit`
- `Realized ROI`
- `Lot-to-date ROI` (current badge)
- `Recovered %` (`sales / cost`)

On create/edit purchase:

- Allocation mode: `Equal` | `Weighted` | `Residual`
- For Residual: field `Expected bulk recovery` (default 0)
- For Weighted: per-card or per-line estimated value
- Constraint: sum of allocated cost in a pool **must equal** `purchase_cost`

Card / line items under a pool:

- `allocated_cost` (editable override)
- status: `In Stock` | `Listed` | `Sold` | `Hold` | `PC` | `Bulk leftover`
- `PC` and unsellable junk do not sit in `sellable_qty`

When a sale posts (eBay/Whatnot/etc.):

- Match to pool SKU (and card id if known)
- `net_sale = gross − fees − shipping_out`
- Add to pool `total_net_sales`
- Mark card Sold and include its `allocated_cost` in `cost_of_sold`

If the sale cannot be tied to a child card (pooled similar lots): burn `purchase_cost / sellable_qty` (or remaining average basis) per card sold.

## Worked numbers from this discussion (use as fixtures)

**Equal pool**

- L-001: 10 cards, $20
- L-002: 5 cards, $10
- Combined: $30 / 15 = $2.00
- Sample sold: nets $6.24, $3.59, $3.60, $4.89 → $18.32 sales, $8 cost of sold
- Realized profit $10.32, realized ROI +129%
- Lot-to-date +34% vs $30, remaining cost $22 on 11 cards

**Weighted 3-card lot**

- Paid $30; values $50 / $5 / $5 → basis $25 / $2.50 / $2.50

**Box, two listers**

- Paid $80; list 2; bulk $10 → hit bases $50 and $20, bulk row $10
- If bulk never sells: both hits share $80 by value ($57.14 and $22.86)

**Current dashboard examples (behavior to fix, not data to overwrite)**

- Select WNBA: $131.77 cost, 9/72 sold, $41.74 sales, −68% lot-to-date — 72 is pack count; realized should use basis of the 9 sold only, and sellable qty should drop to listed+sold+will-sell.
- Sophie Lot: $489.97, 102/102, $594.03, +21% — closed pool; lot-to-date == realized.
- Chrome MLS: $29.99, 1/28, $2.00, −93% — classic “only listed one card from a blaster.”

## Rules the agent must not break

1. Sum of allocated costs in a pool always equals purchase cost.
2. Changing `# Cards` / sellable qty does not change recorded sales or purchase cost.
3. PC / unsellable cards do not receive meaningful basis unless owner assigns it.
4. Do not mix hits and bulk in an equal-split pool.
5. Show realized and lot-to-date side by side. Never hide lot-to-date.
6. Grouped parent SKU (x2, x6…) uses summed cost, summed sales, summed sellable, same two ROIs.
7. Fees and outbound shipping come off sales before ROI. Inbound ship/tax stay in purchase cost.

## Suggested copy for empty/help states

- Realized ROI: “Profit on cards sold so far, against those cards’ share of cost.”
- Lot-to-date ROI: “All sales so far against the full buy. Green when the purchase is recouped.”
- Sellable qty: “Cards you will sell from this pool — not pack count.”
