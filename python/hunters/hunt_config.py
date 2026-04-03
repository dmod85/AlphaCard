"""
AlphaCard - Hunt Configuration
Shared scan parameters passed to all three hunters.
"""

from dataclasses import dataclass


@dataclass
class HuntConfig:
    """
    Configurable scan parameters. Pass to each hunter's hunt() method.

    sport       : "all" | "nfl" | "nba" | "mlb" | "nhl"
    min_price   : Skip listings below this price (default $1)
    max_price   : Skip listings above this price (default $500)
    min_roi     : Minimum rough gross ROI % before fees (default 0)
    min_profit  : Minimum gross profit $ — overrides MIN_PROFIT_THRESHOLD env var
    broad_mode  : If True, ignore watchlist and scan sport-specific broad queries
    """
    sport: str = "all"
    min_price: float = 1.0
    max_price: float = 500.0
    min_roi: float = 0.0
    min_profit: float = 3.0
    broad_mode: bool = False


# Pre-built broad eBay search queries, grouped by sport.
# Hunters use these when broad_mode=True instead of iterating the watchlist.
SPORT_BROAD_QUERIES: dict[str, list[str]] = {
    "nfl": [
        "2025 Prizm football rookie",
        "2025 Select football rookie",
        "2025 Mosaic football rookie",
        "2025 Donruss football rookie",
        "2024 Prizm football rookie",
        "2024 Select football rookie",
        "2024 Bowman's Best football",
        "2025 Topps Finest football rookie",
    ],
    "nba": [
        "2025-26 Prizm basketball rookie",
        "2025-26 Select basketball rookie",
        "2024-25 Prizm basketball rookie",
        "2024-25 Select basketball rookie",
        "2024-25 Hoops basketball rookie",
        "2024-25 Optic basketball rookie",
        "2024-25 Contenders basketball rookie",
        "2024-25 Mosaic basketball rookie",
    ],
    "mlb": [
        "2026 Topps Series 1 baseball rookie",
        "2025 Topps Chrome baseball rookie",
        "2025 Topps Series 1 baseball rookie",
        "2025 Bowman Chrome baseball prospect",
        "2024 Topps Chrome baseball rookie",
        "2024 Stadium Club baseball",
        "2025 Topps Finest baseball rookie",
    ],
    "nhl": [
        "2025-26 Upper Deck hockey rookie",
        "2025-26 OPC Platinum hockey rookie",
        "2024-25 Upper Deck hockey rookie",
        "2024-25 OPC Platinum hockey rookie",
        "2024-25 Synergy hockey rookie",
        "2024-25 SP Authentic hockey",
    ],
}


def get_broad_queries(sport: str = "all") -> list[str]:
    """Return broad eBay search queries for a sport, or all sports combined."""
    if sport == "all":
        queries: list[str] = []
        for q_list in SPORT_BROAD_QUERIES.values():
            queries.extend(q_list)
        return queries
    return SPORT_BROAD_QUERIES.get(sport, [])


def sport_for_query(query: str) -> str:
    """Reverse-lookup which sport a broad query belongs to."""
    query_lower = query.lower()
    for sport, queries in SPORT_BROAD_QUERIES.items():
        if any(query_lower == q.lower() for q in queries):
            return sport
    # Fallback: keyword heuristic
    if any(w in query_lower for w in ("football", "nfl")):
        return "nfl"
    if any(w in query_lower for w in ("basketball", "nba")):
        return "nba"
    if any(w in query_lower for w in ("baseball", "mlb", "topps", "bowman")):
        return "mlb"
    if any(w in query_lower for w in ("hockey", "nhl", "upper deck")):
        return "nhl"
    return "other"


def sport_for_query(query: str) -> str:
    """Return the sport that owns a broad query string."""
    for sport, qs in SPORT_BROAD_QUERIES.items():
        if query in qs:
            return sport
    return "other"
