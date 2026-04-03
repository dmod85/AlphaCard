"""
AlphaCard - Comp Engine
Calculates median sold prices with statistical outlier removal.

Multi-layer filtering:
1. Lot detection — exclude multi-card bundles
2. Title relevance — verify the comp matches the target card
3. IQR outlier removal — strip statistical outliers
4. Median-cap pass — remove anything >3x the initial median
"""

import re
import logging
import statistics
from datetime import datetime
from typing import Optional
from dataclasses import dataclass

from rapidfuzz import fuzz

from utils.ebay_client import EbayClient
from utils.supabase_client import CompsDB

logger = logging.getLogger("alphacard.comps")

# Patterns that indicate a multi-card lot
_LOT_PATTERNS = re.compile(
    r"""
    \b(?:lot|bundle|collection|set\s+of|grab\s+bag|mystery\s+pack)\b
    | \b\d+\s*(?:card|cards)\b          # "10 cards", "5card"
    | \bx\s*\d{2,}\b                    # "x20"
    | \b\d{2,}\s*x\b                    # "20x"
    | \(\d{2,}\)                         # "(25)"
    """,
    re.IGNORECASE | re.VERBOSE,
)

# Patterns for numbered parallels that signal premium cards
_NUMBERED_RE = re.compile(r"/\d{1,4}\b")


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

    Filtering pipeline (applied to every comp candidate):
    1. _is_lot()          — reject multi-card lots
    2. _title_matches()   — confirm player/set/year relevance
    3. Price floor         — reject < $0.99
    4. IQR outlier removal — statistical method
    5. Median-cap pass     — reject > 3× initial median
    """

    def __init__(self, ebay: Optional[EbayClient] = None, comps_db: Optional[CompsDB] = None):
        self.ebay = ebay or EbayClient()
        self.comps_db = comps_db or CompsDB()

    # ------------------------------------------------------------------
    # Filtering helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _is_lot(title: str) -> bool:
        """Detect multi-card lots that would skew comps."""
        return bool(_LOT_PATTERNS.search(title))

    @staticmethod
    def _title_matches(
        title: str,
        player_name: str,
        card_set: Optional[str] = None,
        card_year: Optional[int] = None,
        parallel_type: Optional[str] = None,
    ) -> bool:
        """
        Check that a comp title is actually relevant to the target card.

        Requirements:
        - Player name must fuzzy-match at >=75
        - If card_year provided, it must appear in the title
        - If card_set provided, it must fuzzy-match at >=60
        - If parallel_type is 'base', reject titles with /XXX numbering
        """
        title_lower = title.lower()

        # Player name check (fuzzy)
        if fuzz.partial_ratio(player_name.lower(), title_lower) < 75:
            return False

        # Year check (exact substring)
        if card_year and str(card_year) not in title:
            return False

        # Set check (fuzzy — sellers abbreviate set names)
        if card_set and fuzz.partial_ratio(card_set.lower(), title_lower) < 60:
            return False

        # Base-card guard: reject numbered parallels when we want base comps
        if parallel_type and parallel_type.lower() == "base":
            if _NUMBERED_RE.search(title):
                return False

        return True

    # ------------------------------------------------------------------
    # Outlier removal
    # ------------------------------------------------------------------

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

    @staticmethod
    def _cap_at_median_multiple(prices: list[float], cap: float = 3.0) -> list[float]:
        """
        Second-pass outlier removal: drop anything >cap× the median.
        Catches high-value parallels / autographs that IQR missed
        because IQR widens with high variance.
        """
        if len(prices) < 3:
            return prices
        med = statistics.median(prices)
        floor = med / cap
        ceiling = med * cap
        return [p for p in prices if floor <= p <= ceiling]

    # ------------------------------------------------------------------
    # Confidence scoring
    # ------------------------------------------------------------------

    def _calculate_confidence(self, cleaned_prices: list[float]) -> float:
        """
        Confidence score (0-100) based on comp count and price variance.
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
        cv = stdev / mean

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

    # ------------------------------------------------------------------
    # Main entry point
    # ------------------------------------------------------------------

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

        Pipeline:
        1. Load cached comps (already relevance-filtered on insert)
        2. If too few, fetch from eBay with title filtering
        3. Clean outliers (IQR + median cap)
        4. Mark outliers in the DB for the dashboard
        """
        raw_prices: list[float] = []
        raw_titles: list[str] = []   # parallel list for outlier marking

        # Step 1: Check cache
        if use_cache:
            cached = self.comps_db.get_comps(
                player_name=player_name,
                card_set=card_set,
                card_year=card_year,
                parallel_type=parallel_type,
            )
            if cached:
                for c in cached:
                    title = c.get("title", "")
                    price = float(c["sold_price"])
                    # Re-filter cached results (old data may not have been filtered)
                    if self._is_lot(title):
                        continue
                    if not self._title_matches(title, player_name, card_set, card_year, parallel_type):
                        continue
                    raw_prices.append(price)
                    raw_titles.append(title)
                logger.info(
                    f"Cache hit: {len(cached)} stored, {len(raw_prices)} after relevance filter for {player_name}"
                )

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
                    title = item.get("title", "")
                    price_data = item.get("price", {})
                    price = float(price_data.get("value", 0))
                    if price <= 0:
                        continue

                    # Filter before caching
                    is_lot = self._is_lot(title)
                    is_relevant = self._title_matches(
                        title, player_name, card_set, card_year, parallel_type
                    )

                    # Cache everything but mark lots/irrelevant as outliers
                    self.comps_db.upsert_comps([{
                        "ebay_item_id": item.get("itemId", ""),
                        "title": title,
                        "sold_price": price,
                        "sold_date": item.get("itemEndDate") or datetime.utcnow().isoformat(),
                        "player_name": player_name,
                        "card_year": card_year,
                        "card_set": card_set,
                        "parallel_type": parallel_type,
                        "image_url": (item.get("image", {}) or {}).get("imageUrl"),
                        "item_url": item.get("itemWebUrl"),
                        "is_outlier": is_lot or not is_relevant,
                        "outlier_reason": (
                            "lot" if is_lot
                            else "irrelevant title" if not is_relevant
                            else None
                        ),
                    }])

                    if not is_lot and is_relevant:
                        raw_prices.append(price)
                        raw_titles.append(title)
            except Exception as e:
                logger.error(f"Failed to fetch comps: {e}")

        if not raw_prices:
            logger.warning(f"No comps found for {player_name}")
            return None

        # Step 3: Remove outliers — three passes
        # Pass 1: price floor
        filtered = [p for p in raw_prices if p >= 0.99]
        # Pass 2: IQR method
        cleaned = self._remove_outliers_iqr(filtered)
        # Pass 3: median cap (catches high-value parallels IQR missed)
        cleaned = self._cap_at_median_multiple(cleaned, cap=3.0)

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
