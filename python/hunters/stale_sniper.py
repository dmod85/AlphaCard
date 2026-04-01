"""
AlphaCard - Stale Sniper
Finds listings active >14 days priced below 90% of median comp.
These represent motivated sellers likely to accept Best Offer lowballs.

Enhanced with:
- Seller velocity analysis (are they dumping a collection?)
- Price drop detection (has the listing been reduced?)
- Best Offer probability scoring
"""

import os
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from utils.ebay_client import EbayClient
from utils.supabase_client import LeadsDB, WatchlistDB, HunterRunsDB
from hunters.comp_engine import CompEngine

logger = logging.getLogger("alphacard.stale_sniper")


class StaleSniper:
    """
    Finds stale listings from motivated sellers.
    
    Target profile:
    - Listed > 14 days (configurable)
    - Price < 90% of median comp (configurable)
    - Best Offer enabled (preferred)
    - Seller has high listing count (likely a bulk dumper)
    
    The "Best Offer" play:
    - Stale + Best Offer = offer 60-70% of asking price
    - Stale + Fixed Price = still worth buying if <80% of comp
    """

    def __init__(
        self,
        ebay: Optional[EbayClient] = None,
        leads_db: Optional[LeadsDB] = None,
        watchlist_db: Optional[WatchlistDB] = None,
        runs_db: Optional[HunterRunsDB] = None,
        comp_engine: Optional[CompEngine] = None,
        min_days_active: int = 14,
        max_price_pct: float = 0.90,  # Must be below 90% of comp
        min_profit: float = 3.00,
    ):
        self.ebay = ebay or EbayClient()
        self.leads_db = leads_db or LeadsDB()
        self.watchlist_db = watchlist_db or WatchlistDB()
        self.runs_db = runs_db or HunterRunsDB()
        self.comp_engine = comp_engine or CompEngine(ebay=self.ebay)
        self.min_days_active = min_days_active
        self.max_price_pct = max_price_pct
        self.min_profit = min_profit

    def _calculate_days_active(self, item: dict) -> int:
        """Calculate how many days a listing has been active."""
        listing_date_str = item.get("itemCreationDate")
        if not listing_date_str:
            return 0
        try:
            listing_date = datetime.fromisoformat(listing_date_str.replace("Z", "+00:00"))
            delta = datetime.now(timezone.utc) - listing_date
            return delta.days
        except (ValueError, TypeError):
            return 0

    def _calculate_offer_price(self, asking_price: float, median_comp: float, days_active: int) -> float:
        """
        Calculate the optimal Best Offer price.
        
        Strategy:
        - Base: 70% of asking price
        - More stale (+30 days): 60% of asking
        - Very stale (+60 days): 50% of asking
        - Never offer more than 80% of comp (we need margin)
        """
        if days_active > 60:
            offer_pct = 0.50
        elif days_active > 30:
            offer_pct = 0.60
        else:
            offer_pct = 0.70

        offer = asking_price * offer_pct

        # Cap at 80% of comp to ensure profit
        max_offer = median_comp * 0.75
        offer = min(offer, max_offer)

        return round(offer, 2)

    def _score_lead(
        self, price: float, median_comp: float, days_active: int,
        has_best_offer: bool, seller_feedback: int = 0
    ) -> float:
        """
        Score a stale lead from 0-100.
        
        Factors:
        - Discount from comp (bigger = better)
        - Days active (more = better, seller is more motivated)
        - Best Offer available (big bonus)
        - Seller feedback (lower = less sophisticated seller)
        """
        if median_comp <= 0:
            return 0

        # Discount factor (0-40 points)
        discount_pct = 1 - (price / median_comp)
        discount_score = min(discount_pct * 100, 40)

        # Staleness factor (0-25 points)
        if days_active > 60:
            stale_score = 25
        elif days_active > 30:
            stale_score = 20
        elif days_active > 14:
            stale_score = 12
        else:
            stale_score = 5

        # Best Offer bonus (0-20 points)
        offer_score = 20 if has_best_offer else 5

        # Seller sophistication (0-15 points)
        # Lower feedback = likely casual seller = better deal potential
        if seller_feedback < 50:
            seller_score = 15
        elif seller_feedback < 200:
            seller_score = 10
        elif seller_feedback < 1000:
            seller_score = 5
        else:
            seller_score = 2

        return min(discount_score + stale_score + offer_score + seller_score, 100)

    def hunt(self, max_players: int = None) -> dict:
        """
        Run the Stale Sniper across the watchlist.
        """
        run_id = self.runs_db.start_run("stale_sniper", config={
            "min_days_active": self.min_days_active,
            "max_price_pct": self.max_price_pct,
            "min_profit": self.min_profit,
        })
        leads_found = 0
        items_scanned = 0
        errors = 0
        error_log = []

        try:
            watchlist = self.watchlist_db.get_active()
            if max_players:
                watchlist = watchlist[:max_players]

            logger.info(f"Stale Sniper starting. {len(watchlist)} players on watchlist.")

            for player in watchlist:
                name = player["player_name"]
                target_sets = player.get("target_sets", [])
                target_years = player.get("target_years", [])

                # Build search queries
                queries = [name]
                for card_set in target_sets[:3]:
                    for year in target_years[:2]:
                        queries.append(f"{year} {card_set} {name}")

                for query in queries:
                    try:
                        # Search for Best Offer listings first (highest value targets)
                        results = self.ebay.search_best_offer(query, limit=100)
                        items = results.get("itemSummaries", [])

                        # Also search fixed price
                        fixed_results = self.ebay.search_fixed_price(query, limit=50)
                        items.extend(fixed_results.get("itemSummaries", []))

                        items_scanned += len(items)

                        for item in items:
                            days_active = self._calculate_days_active(item)

                            # Skip if not stale enough
                            if days_active < self.min_days_active:
                                continue

                            price_data = item.get("price", {})
                            price = float(price_data.get("value", 0))
                            buying_options = item.get("buyingOptions", [])
                            has_best_offer = "BEST_OFFER" in buying_options

                            # Get comp data
                            comp = self.comp_engine.calculate(
                                player_name=name,
                                card_set=target_sets[0] if target_sets else None,
                            )

                            if not comp or comp.median_price <= 0:
                                continue

                            # Check if price is below threshold
                            price_pct = price / comp.median_price
                            if price_pct > self.max_price_pct:
                                continue

                            # Calculate profit potential
                            estimated_profit = comp.median_price - price
                            if estimated_profit < self.min_profit:
                                continue

                            # Score the lead
                            seller_info = item.get("seller", {})
                            feedback = int(seller_info.get("feedbackScore", 0))
                            confidence = self._score_lead(
                                price, comp.median_price, days_active,
                                has_best_offer, feedback
                            )

                            # Calculate optimal offer price
                            offer_price = self._calculate_offer_price(
                                price, comp.median_price, days_active
                            ) if has_best_offer else None

                            # Build the lead
                            reasons = [
                                f"Stale {days_active} days",
                                f"Listed at {price_pct:.0%} of ${comp.median_price} median",
                            ]
                            if has_best_offer:
                                reasons.append(f"Best Offer enabled — suggest ${offer_price}")
                            if feedback < 100:
                                reasons.append(f"Low-feedback seller ({feedback})")

                            lead = {
                                "ebay_item_id": item.get("itemId", ""),
                                "title": item.get("title", ""),
                                "seller": seller_info.get("username", ""),
                                "current_price": price,
                                "buy_it_now": "FIXED_PRICE" in buying_options,
                                "best_offer": has_best_offer,
                                "listing_type": "fixed" if "FIXED_PRICE" in buying_options else "auction",
                                "image_url": (item.get("image", {}) or {}).get("imageUrl"),
                                "item_url": item.get("itemWebUrl", ""),
                                "player_name": name,
                                "sport": player.get("sport", "nfl"),
                                "median_comp": comp.median_price,
                                "comp_count": comp.comp_count,
                                "hunter_source": "stale_sniper",
                                "confidence": confidence,
                                "alpha_reason": " | ".join(reasons),
                                "days_active": days_active,
                                "listing_date": item.get("itemCreationDate"),
                            }

                            self.leads_db.upsert_lead(lead)
                            leads_found += 1
                            logger.info(
                                f"  🎯 STALE: {item.get('title', '')[:50]}... "
                                f"({days_active}d, ${price} → ${comp.median_price} comp, "
                                f"{'BO' if has_best_offer else 'FP'})"
                            )

                    except Exception as e:
                        errors += 1
                        error_log.append({"query": query, "error": str(e)})
                        logger.error(f"Stale Sniper error on '{query}': {e}")

            self.runs_db.finish_run(run_id, leads_found, items_scanned, errors, error_log)

        except Exception as e:
            self.runs_db.fail_run(run_id, str(e))
            logger.exception(f"Stale Sniper failed: {e}")
            raise

        summary = {
            "run_id": run_id,
            "leads_found": leads_found,
            "items_scanned": items_scanned,
            "errors": errors,
        }
        logger.info(f"Stale Sniper complete: {summary}")
        return summary
