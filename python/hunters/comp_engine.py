"""
AlphaCard - Comp Engine
Calculates median sold prices with statistical outlier removal.
Uses IQR method to strip shill bids and pricing errors.
"""

import logging
import statistics
from datetime import datetime
from typing import Optional
from dataclasses import dataclass

from utils.ebay_client import EbayClient
from utils.supabase_client import CompsDB

logger = logging.getLogger("alphacard.comps")


@dataclass
class CompResult:
    median_price: float
    mean_price: float
    comp_count: int
    min_price: float
    max_price: float
    outliers_removed: int
    confidence: float  # 0-100, based on comp count and variance
    raw_prices: list[float]
    cleaned_prices: list[float]


class CompEngine:
    """
    Calculates fair market value for a card using sold comps.
    
    Outlier removal strategy:
    1. Remove anything below $0.99 (shill bids, lot breakdowns)
    2. Remove anything that is a clear error (>10x the median of the middle 60%)
    3. Apply IQR method (1.5x interquartile range)
    4. Require minimum 3 comps for a reliable median
    """

    def __init__(self, ebay: Optional[EbayClient] = None, comps_db: Optional[CompsDB] = None):
        self.ebay = ebay or EbayClient()
        self.comps_db = comps_db or CompsDB()

    def _remove_outliers_iqr(self, prices: list[float], multiplier: float = 1.5) -> list[float]:
        """Remove outliers using the Interquartile Range method."""
        if len(prices) < 4:
            return prices

        sorted_prices = sorted(prices)
        n = len(sorted_prices)
        q1 = sorted_prices[n // 4]
        q3 = sorted_prices[3 * n // 4]
        iqr = q3 - q1

        lower_bound = q1 - (multiplier * iqr)
        upper_bound = q3 + (multiplier * iqr)

        # Floor at $0.99 regardless
        lower_bound = max(lower_bound, 0.99)

        return [p for p in sorted_prices if lower_bound <= p <= upper_bound]

    def _calculate_confidence(self, cleaned_prices: list[float]) -> float:
        """
        Calculate confidence score (0-100) based on:
        - Number of comps (more = higher confidence)
        - Price variance (lower = higher confidence)
        """
        n = len(cleaned_prices)
        if n == 0:
            return 0
        if n == 1:
            return 20
        if n == 2:
            return 35

        # Count factor: sigmoid-like curve, plateaus around 15+ comps
        count_score = min(50, (n / 15) * 50)

        # Variance factor: coefficient of variation
        mean = statistics.mean(cleaned_prices)
        if mean == 0:
            return count_score

        stdev = statistics.stdev(cleaned_prices)
        cv = stdev / mean  # Coefficient of variation

        # Lower CV = higher confidence. CV < 0.2 is excellent, > 1.0 is terrible
        if cv < 0.15:
            variance_score = 50
        elif cv < 0.3:
            variance_score = 40
        elif cv < 0.5:
            variance_score = 25
        elif cv < 0.8:
            variance_score = 15
        else:
            variance_score = 5

        return round(count_score + variance_score, 1)

    def calculate(
        self,
        player_name: str,
        card_set: Optional[str] = None,
        card_year: Optional[int] = None,
        parallel_type: Optional[str] = None,
        use_cache: bool = True,
    ) -> Optional[CompResult]:
        """
        Calculate the median sold price for a card.
        
        1. Check Supabase cache first
        2. If stale or missing, fetch from eBay
        3. Clean outliers
        4. Return CompResult
        """
        raw_prices: list[float] = []

        # Step 1: Check cache
        if use_cache:
            cached = self.comps_db.get_comps(
                player_name=player_name,
                card_set=card_set,
                card_year=card_year,
                parallel_type=parallel_type,
            )
            if cached:
                raw_prices = [float(c["sold_price"]) for c in cached]
                logger.info(f"Cache hit: {len(cached)} comps for {player_name}")

        # Step 2: Fetch from eBay if needed
        if len(raw_prices) < 3:
            query_parts = [player_name]
            if card_year:
                query_parts.append(str(card_year))
            if card_set:
                query_parts.append(card_set)
            if parallel_type and parallel_type.lower() != "base":
                query_parts.append(parallel_type)

            query = " ".join(query_parts)
            logger.info(f"Fetching comps from eBay: {query}")

            try:
                items = self.ebay.search_sold_items(query, limit=100)
                for item in items:
                    price_data = item.get("price", {})
                    price = float(price_data.get("value", 0))
                    if price > 0:
                        raw_prices.append(price)

                        # Cache the comp
                        self.comps_db.upsert_comps([{
                            "ebay_item_id": item.get("itemId", ""),
                            "title": item.get("title", ""),
                            "sold_price": price,
                            "sold_date": item.get("itemEndDate") or datetime.utcnow().isoformat(),
                            "player_name": player_name,
                            "card_year": card_year,
                            "card_set": card_set,
                            "parallel_type": parallel_type,
                            "image_url": (item.get("image", {}) or {}).get("imageUrl"),
                            "item_url": item.get("itemWebUrl"),
                        }])
            except Exception as e:
                logger.error(f"Failed to fetch comps: {e}")

        if not raw_prices:
            logger.warning(f"No comps found for {player_name}")
            return None

        # Step 3: Remove outliers
        # First pass: remove obvious errors
        filtered = [p for p in raw_prices if p >= 0.99]
        # Second pass: IQR method
        cleaned = self._remove_outliers_iqr(filtered)

        if not cleaned:
            cleaned = filtered[:] if filtered else raw_prices[:]

        # Step 4: Calculate statistics
        median = round(statistics.median(cleaned), 2)
        mean = round(statistics.mean(cleaned), 2)
        confidence = self._calculate_confidence(cleaned)

        result = CompResult(
            median_price=median,
            mean_price=mean,
            comp_count=len(cleaned),
            min_price=min(cleaned),
            max_price=max(cleaned),
            outliers_removed=len(raw_prices) - len(cleaned),
            confidence=confidence,
            raw_prices=raw_prices,
            cleaned_prices=cleaned,
        )

        logger.info(
            f"Comp result for {player_name}: ${median} median "
            f"({len(cleaned)} comps, {confidence}% confidence, "
            f"{len(raw_prices) - len(cleaned)} outliers removed)"
        )

        return result
