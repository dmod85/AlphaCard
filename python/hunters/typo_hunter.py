"""
AlphaCard - Typo Hunter
Finds undervalued listings by searching for common misspellings.
Uses Levenshtein distance + phonetic matching + custom card-world typo patterns.
"""

import logging
import itertools
from typing import Optional
from dataclasses import dataclass

from rapidfuzz import fuzz, process
from rapidfuzz.distance import Levenshtein

from utils.ebay_client import EbayClient
from utils.supabase_client import LeadsDB, WatchlistDB, HunterRunsDB
from hunters.comp_engine import CompEngine

logger = logging.getLogger("alphacard.typo_hunter")


@dataclass
class TypoVariant:
    original: str
    variant: str
    distance: int
    method: str  # 'stored', 'swap', 'drop', 'phonetic', 'spacing'


class TypoGenerator:
    """
    Generates plausible misspellings for player names and card terms.
    Goes beyond simple Levenshtein — uses card-hobby-specific patterns.
    """

    # Common card-world misspellings
    PARALLEL_TYPOS = {
        "prizm": ["prism", "priszm", "prsim", "prizim"],
        "refractor": ["refactor", "refraktor", "refracter", "reflector"],
        "optic": ["opti", "optik", "opitc"],
        "mosaic": ["mosaik", "mosiac", "mossaic"],
        "select": ["selct", "seelct"],
        "chrome": ["crome", "chome", "chrme"],
        "bowman": ["bowmen", "bowmam"],
        "topps": ["tops", "toops"],
        "panini": ["pannini", "panini", "panni"],
    }

    # Commonly confused characters
    CHAR_SWAPS = {
        "c": ["k", "s"],
        "k": ["c"],
        "y": ["ie", "ey", "i"],
        "ie": ["y", "ey"],
        "ph": ["f"],
        "ck": ["k", "c"],
        "ll": ["l"],
        "tt": ["t"],
        "ss": ["s"],
        "ee": ["e", "ea"],
        "oo": ["o", "u"],
        "ou": ["o", "ow"],
    }

    def generate_variants(self, name: str, stored_typos: list[str] = None) -> list[TypoVariant]:
        """Generate all plausible misspellings for a name."""
        variants: list[TypoVariant] = []
        seen = {name.lower()}

        # 1. Stored known typos (from watchlist)
        for typo in (stored_typos or []):
            if typo.lower() not in seen:
                seen.add(typo.lower())
                variants.append(TypoVariant(
                    original=name, variant=typo,
                    distance=Levenshtein.distance(name.lower(), typo.lower()),
                    method="stored"
                ))

        # 2. Character transpositions (adjacent swap)
        words = name.split()
        for w_idx, word in enumerate(words):
            for i in range(len(word) - 1):
                swapped = word[:i] + word[i + 1] + word[i] + word[i + 2:]
                new_name = " ".join(words[:w_idx] + [swapped] + words[w_idx + 1:])
                if new_name.lower() not in seen:
                    seen.add(new_name.lower())
                    variants.append(TypoVariant(
                        original=name, variant=new_name,
                        distance=1, method="swap"
                    ))

        # 3. Character drops
        for w_idx, word in enumerate(words):
            if len(word) > 3:
                for i in range(1, len(word) - 1):  # Don't drop first/last
                    dropped = word[:i] + word[i + 1:]
                    new_name = " ".join(words[:w_idx] + [dropped] + words[w_idx + 1:])
                    if new_name.lower() not in seen:
                        seen.add(new_name.lower())
                        variants.append(TypoVariant(
                            original=name, variant=new_name,
                            distance=1, method="drop"
                        ))

        # 4. Spacing variations (C.J. vs CJ vs C J)
        spacing_variants = set()
        # Remove periods
        no_periods = name.replace(".", "")
        spacing_variants.add(no_periods)
        # Remove hyphens
        no_hyphens = name.replace("-", " ")
        spacing_variants.add(no_hyphens)
        # Smash initials together
        spacing_variants.add(name.replace(". ", "").replace(".", ""))
        # Add periods where missing
        if len(words[0]) == 2 and words[0].isupper():
            spacing_variants.add(f"{words[0][0]}.{words[0][1]}. {' '.join(words[1:])}")

        for sv in spacing_variants:
            if sv.lower() not in seen:
                seen.add(sv.lower())
                variants.append(TypoVariant(
                    original=name, variant=sv,
                    distance=Levenshtein.distance(name.lower(), sv.lower()),
                    method="spacing"
                ))

        # 5. Name order reversal (First Last -> Last First)
        if len(words) >= 2:
            reversed_name = f"{words[-1]} {' '.join(words[:-1])}"
            if reversed_name.lower() not in seen:
                seen.add(reversed_name.lower())
                variants.append(TypoVariant(
                    original=name, variant=reversed_name,
                    distance=Levenshtein.distance(name.lower(), reversed_name.lower()),
                    method="spacing"
                ))

        return variants


class TypoHunter:
    """
    Searches eBay for misspelled listings that standard searches miss.
    
    Strategy:
    1. Load player watchlist
    2. Generate typo variants for each player
    3. Search eBay for each variant
    4. Score found listings against comps
    5. Push high-confidence leads to Supabase
    """

    def __init__(
        self,
        ebay: Optional[EbayClient] = None,
        leads_db: Optional[LeadsDB] = None,
        watchlist_db: Optional[WatchlistDB] = None,
        runs_db: Optional[HunterRunsDB] = None,
        comp_engine: Optional[CompEngine] = None,
    ):
        self.ebay = ebay or EbayClient()
        self.leads_db = leads_db or LeadsDB()
        self.watchlist_db = watchlist_db or WatchlistDB()
        self.runs_db = runs_db or HunterRunsDB()
        self.comp_engine = comp_engine or CompEngine(ebay=self.ebay)
        self.typo_gen = TypoGenerator()

    def _is_card_listing(self, title: str) -> bool:
        """Quick check if a listing is actually a sports card."""
        card_keywords = [
            "card", "rookie", "rc", "prizm", "select", "optic", "mosaic",
            "chrome", "refractor", "auto", "patch", "jersey", "bowman",
            "topps", "panini", "donruss", "base", "parallel", "insert",
            "numbered", "/", "#", "psa", "bgs", "sgc", "cgc",
        ]
        title_lower = title.lower()
        return any(kw in title_lower for kw in card_keywords)

    def _extract_listing_data(self, item: dict, typo_variant: TypoVariant) -> dict:
        """Transform an eBay item into a lead record."""
        price_data = item.get("price", {})
        price = float(price_data.get("value", 0))

        buying_options = item.get("buyingOptions", [])
        image = item.get("image", {}) or {}

        return {
            "ebay_item_id": item.get("itemId", ""),
            "title": item.get("title", ""),
            "seller": item.get("seller", {}).get("username", ""),
            "current_price": price,
            "buy_it_now": "FIXED_PRICE" in buying_options,
            "best_offer": "BEST_OFFER" in buying_options,
            "listing_type": "fixed" if "FIXED_PRICE" in buying_options else "auction",
            "image_url": image.get("imageUrl"),
            "item_url": item.get("itemWebUrl", ""),
            "player_name": typo_variant.original,
            "hunter_source": "typo_hunter",
            "typo_original": typo_variant.variant,
            "alpha_reason": (
                f"Found via typo search: '{typo_variant.variant}' "
                f"(Levenshtein distance: {typo_variant.distance}, "
                f"method: {typo_variant.method})"
            ),
        }

    def hunt(self, max_players: int = None) -> dict:
        """
        Run the Typo Hunter across the entire watchlist.
        
        Returns:
            Summary dict with leads_found, items_scanned, errors
        """
        run_id = self.runs_db.start_run("typo_hunter")
        leads_found = 0
        items_scanned = 0
        errors = 0
        error_log = []

        try:
            watchlist = self.watchlist_db.get_active()
            if max_players:
                watchlist = watchlist[:max_players]

            logger.info(f"Typo Hunter starting. {len(watchlist)} players on watchlist.")

            for player in watchlist:
                name = player["player_name"]
                stored_typos = player.get("common_typos", [])
                target_sets = player.get("target_sets", [])

                variants = self.typo_gen.generate_variants(name, stored_typos)
                logger.info(f"  {name}: {len(variants)} typo variants generated")

                for variant in variants:
                    try:
                        # Build search queries combining typo + set names
                        queries = [variant.variant]
                        for card_set in target_sets[:3]:
                            queries.append(f"{variant.variant} {card_set}")

                        for query in queries:
                            results = self.ebay.search_fixed_price(query, limit=50)
                            items = results.get("itemSummaries", [])
                            items_scanned += len(items)

                            for item in items:
                                title = item.get("title", "")

                                # Verify it's a card listing
                                if not self._is_card_listing(title):
                                    continue

                                # Check fuzzy match to confirm it's the right player
                                title_match = fuzz.partial_ratio(
                                    name.lower(), title.lower()
                                )
                                if title_match < 60:
                                    continue

                                lead = self._extract_listing_data(item, variant)

                                # Get comp data
                                comp = self.comp_engine.calculate(
                                    player_name=name,
                                    card_set=target_sets[0] if target_sets else None,
                                )

                                if comp and comp.median_price > 0:
                                    lead["median_comp"] = comp.median_price
                                    lead["comp_count"] = comp.comp_count
                                    lead["confidence"] = min(
                                        comp.confidence + (10 if variant.method == "stored" else 0),
                                        100,
                                    )

                                    # Only save if there's profit potential
                                    if lead.get("estimated_profit", 0) > float(
                                        os.environ.get("MIN_PROFIT_THRESHOLD", 3)
                                    ):
                                        self.leads_db.upsert_lead(lead)
                                        leads_found += 1
                                        logger.info(
                                            f"  💰 LEAD: {title[:60]}... "
                                            f"(${lead['current_price']} → ${comp.median_price} median)"
                                        )

                    except Exception as e:
                        errors += 1
                        error_log.append({
                            "player": name,
                            "variant": variant.variant,
                            "error": str(e),
                        })
                        logger.error(f"Error searching '{variant.variant}': {e}")

            self.runs_db.finish_run(
                run_id, leads_found, items_scanned, errors, error_log
            )

        except Exception as e:
            self.runs_db.fail_run(run_id, str(e))
            logger.exception(f"Typo Hunter failed: {e}")
            raise

        summary = {
            "run_id": run_id,
            "leads_found": leads_found,
            "items_scanned": items_scanned,
            "errors": errors,
        }
        logger.info(f"Typo Hunter complete: {summary}")
        return summary


# Allow importing os at module level (used in hunt method)
import os
