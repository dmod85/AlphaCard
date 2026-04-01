"""
AlphaCard - Holo-Heuristic Engine
Identifies shiny/parallel cards mislisted as base cards.

Two detection methods:
1. Metadata Analysis - Check title & item specifics for parallel keywords
2. Pixel Variance - Detect "shininess" via image color channel analysis
"""

import io
import logging
from typing import Optional
from dataclasses import dataclass

import numpy as np
from PIL import Image

from utils.ebay_client import EbayClient
from utils.supabase_client import LeadsDB, HunterRunsDB
from hunters.comp_engine import CompEngine

logger = logging.getLogger("alphacard.holo_engine")


# Keywords that indicate a parallel/insert but sellers often omit from titles
PARALLEL_KEYWORDS = {
    "high_value": [
        "auto", "autograph", "patch", "rpa", "logoman",
        "1/1", "one of one", "printing plate",
    ],
    "prizm_parallels": [
        "silver", "gold", "red", "blue", "green", "orange", "purple",
        "pink", "neon green", "hyper", "mojo", "camo",
        "disco", "fast break", "choice", "ice",
    ],
    "refractor_parallels": [
        "refractor", "x-fractor", "gold refractor", "orange refractor",
        "superfractor", "atomic", "prism", "wave", "aqua",
    ],
    "numbered": [
        "/25", "/50", "/75", "/99", "/100", "/149", "/150",
        "/199", "/249", "/299", "/399", "/499",
    ],
    "inserts": [
        "insert", "die-cut", "die cut", "cracked ice",
        "downtown", "kaboom", "color blast", "case hit",
    ],
}

ALL_PARALLEL_KEYWORDS = []
for group in PARALLEL_KEYWORDS.values():
    ALL_PARALLEL_KEYWORDS.extend(group)


@dataclass
class HoloAnalysis:
    is_likely_parallel: bool
    confidence: float  # 0-100
    detected_keywords: list[str]
    pixel_shininess: float  # 0-1 scale
    color_variance: float
    saturation_peaks: int
    reasoning: str


class ImageAnalyzer:
    """
    Analyzes card images for visual indicators of parallel/refractor cards.
    
    Parallel cards have:
    - Higher color saturation variance (rainbow/prismatic effects)
    - More "hot spots" from light reflection
    - Higher pixel variance in the border/background region
    - Distinct color channel histograms (base cards are more uniform)
    """

    def __init__(self, min_shininess: float = 0.35):
        self.min_shininess = min_shininess

    def analyze(self, image_bytes: bytes) -> HoloAnalysis:
        """Analyze an image for parallel card indicators."""
        try:
            img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
            img = img.resize((300, 420))  # Normalize card size
            pixels = np.array(img, dtype=np.float64)

            # 1. Overall color variance (parallels have higher variance)
            color_variance = float(np.std(pixels))

            # 2. Saturation analysis (HSV)
            # Convert to HSV-like analysis
            r, g, b = pixels[:, :, 0], pixels[:, :, 1], pixels[:, :, 2]
            max_rgb = np.maximum(np.maximum(r, g), b)
            min_rgb = np.minimum(np.minimum(r, g), b)
            saturation = np.where(max_rgb > 0, (max_rgb - min_rgb) / max_rgb, 0)

            mean_saturation = float(np.mean(saturation))
            saturation_std = float(np.std(saturation))

            # Count high-saturation "hot spots"
            hot_spots = int(np.sum(saturation > 0.7))
            total_pixels = saturation.size
            hot_spot_ratio = hot_spots / total_pixels

            # 3. Border region analysis (parallels often have colored borders)
            border_width = 20
            border_region = np.concatenate([
                pixels[:border_width, :, :].reshape(-1, 3),  # Top
                pixels[-border_width:, :, :].reshape(-1, 3),  # Bottom
                pixels[:, :border_width, :].reshape(-1, 3),  # Left
                pixels[:, -border_width:, :].reshape(-1, 3),  # Right
            ])
            border_variance = float(np.std(border_region))
            border_saturation = float(np.mean(
                np.where(
                    np.max(border_region, axis=1) > 0,
                    (np.max(border_region, axis=1) - np.min(border_region, axis=1))
                    / np.max(border_region, axis=1),
                    0,
                )
            ))

            # 4. Channel histogram analysis
            # Parallels tend to have multi-modal color distributions
            r_peaks = self._count_histogram_peaks(r.flatten())
            g_peaks = self._count_histogram_peaks(g.flatten())
            b_peaks = self._count_histogram_peaks(b.flatten())
            total_peaks = r_peaks + g_peaks + b_peaks

            # 5. Composite "shininess" score
            shininess = self._calculate_shininess(
                color_variance=color_variance,
                saturation_std=saturation_std,
                hot_spot_ratio=hot_spot_ratio,
                border_saturation=border_saturation,
                total_peaks=total_peaks,
            )

            is_parallel = shininess >= self.min_shininess
            confidence = min(shininess * 100, 95)  # Cap at 95 (image analysis isn't perfect)

            reasoning_parts = []
            if shininess >= 0.6:
                reasoning_parts.append("Strong prismatic/reflective patterns detected")
            elif shininess >= 0.35:
                reasoning_parts.append("Moderate shimmer/color variance detected")

            if hot_spot_ratio > 0.1:
                reasoning_parts.append(f"High-saturation hot spots: {hot_spot_ratio:.1%} of pixels")
            if border_saturation > 0.3:
                reasoning_parts.append(f"Colored border detected (sat: {border_saturation:.2f})")
            if total_peaks > 9:
                reasoning_parts.append(f"Multi-modal color distribution ({total_peaks} peaks)")

            return HoloAnalysis(
                is_likely_parallel=is_parallel,
                confidence=confidence,
                detected_keywords=[],
                pixel_shininess=round(shininess, 3),
                color_variance=round(color_variance, 2),
                saturation_peaks=total_peaks,
                reasoning=" | ".join(reasoning_parts) if reasoning_parts else "No parallel indicators",
            )

        except Exception as e:
            logger.error(f"Image analysis failed: {e}")
            return HoloAnalysis(
                is_likely_parallel=False,
                confidence=0,
                detected_keywords=[],
                pixel_shininess=0,
                color_variance=0,
                saturation_peaks=0,
                reasoning=f"Analysis error: {e}",
            )

    def _count_histogram_peaks(self, channel: np.ndarray, bins: int = 32) -> int:
        """Count peaks in a color channel histogram."""
        hist, _ = np.histogram(channel, bins=bins, range=(0, 255))
        hist = hist / hist.max() if hist.max() > 0 else hist

        peaks = 0
        for i in range(1, len(hist) - 1):
            if hist[i] > hist[i - 1] and hist[i] > hist[i + 1] and hist[i] > 0.1:
                peaks += 1
        return peaks

    def _calculate_shininess(
        self,
        color_variance: float,
        saturation_std: float,
        hot_spot_ratio: float,
        border_saturation: float,
        total_peaks: int,
    ) -> float:
        """
        Composite shininess score (0-1).
        Weighted combination of visual indicators.
        """
        # Normalize each factor to 0-1
        cv_score = min(color_variance / 100, 1.0) * 0.2
        sat_score = min(saturation_std / 0.3, 1.0) * 0.25
        hs_score = min(hot_spot_ratio / 0.15, 1.0) * 0.2
        border_score = min(border_saturation / 0.4, 1.0) * 0.2
        peak_score = min(total_peaks / 12, 1.0) * 0.15

        return cv_score + sat_score + hs_score + border_score + peak_score


class HoloHeuristicEngine:
    """
    Finds cards listed as "base" that are actually parallels/inserts.
    
    Two-pronged approach:
    1. Text analysis: Check item specifics and description for parallel keywords
    2. Image analysis: Pixel-level shininess detection
    """

    def __init__(
        self,
        ebay: Optional[EbayClient] = None,
        leads_db: Optional[LeadsDB] = None,
        runs_db: Optional[HunterRunsDB] = None,
        comp_engine: Optional[CompEngine] = None,
    ):
        self.ebay = ebay or EbayClient()
        self.leads_db = leads_db or LeadsDB()
        self.runs_db = runs_db or HunterRunsDB()
        self.comp_engine = comp_engine or CompEngine(ebay=self.ebay)
        self.image_analyzer = ImageAnalyzer()

    def _check_title_for_parallels(self, title: str) -> list[str]:
        """Check if the title mentions parallel keywords."""
        title_lower = title.lower()
        found = []
        for kw in ALL_PARALLEL_KEYWORDS:
            if kw.lower() in title_lower:
                found.append(kw)
        return found

    def _check_specifics_mismatch(self, item: dict) -> tuple[bool, list[str]]:
        """
        Check if item specifics mention a parallel that's NOT in the title.
        This is where the alpha is — sellers fill out specifics accurately
        but use lazy titles like "2023 Prizm CJ Stroud Rookie Card"
        when it's actually a Silver Prizm.
        """
        title_lower = item.get("title", "").lower()
        specifics = item.get("localizedAspects", [])

        mismatch_keywords = []
        for spec in specifics:
            name = spec.get("name", "").lower()
            value = spec.get("value", "").lower()

            # Check if specifics mention a parallel not in the title
            if name in ("parallel/variety", "card attributes", "features", "type"):
                for kw in ALL_PARALLEL_KEYWORDS:
                    if kw.lower() in value and kw.lower() not in title_lower:
                        mismatch_keywords.append(f"{name}: {value}")

        return bool(mismatch_keywords), mismatch_keywords

    def hunt(self, queries: list[str] = None, analyze_images: bool = True) -> dict:
        """
        Run the Holo-Heuristic Engine.
        
        Default queries focus on common base card listings that might be parallels.
        """
        run_id = self.runs_db.start_run("holo_heuristic")
        leads_found = 0
        items_scanned = 0
        errors = 0

        if queries is None:
            queries = [
                "2024 Prizm football base rookie",
                "2024 Select football base",
                "2023-24 Prizm basketball base rookie",
                "2024 Topps Chrome baseball base",
                "2024 Donruss football base rookie",
            ]

        try:
            for query in queries:
                logger.info(f"Holo scan: {query}")
                results = self.ebay.search_fixed_price(query, limit=100)
                items = results.get("itemSummaries", [])
                items_scanned += len(items)

                for item in items:
                    title = item.get("title", "")
                    title_keywords = self._check_title_for_parallels(title)

                    # Skip if title already mentions a parallel
                    if title_keywords:
                        continue

                    # Check item specifics for mismatch
                    try:
                        full_item = self.ebay.get_item(item.get("itemId", ""))
                        has_mismatch, mismatch_kws = self._check_specifics_mismatch(full_item)
                    except Exception:
                        has_mismatch = False
                        mismatch_kws = []

                    # Optional: Image analysis
                    holo_analysis = None
                    if analyze_images:
                        image_url = (item.get("image", {}) or {}).get("imageUrl")
                        if image_url:
                            try:
                                img_bytes = self.ebay.download_image(image_url)
                                holo_analysis = self.image_analyzer.analyze(img_bytes)
                            except Exception as e:
                                logger.debug(f"Image analysis failed: {e}")

                    # Decision: Is this a hidden parallel?
                    is_lead = False
                    confidence = 0
                    reasons = []

                    if has_mismatch:
                        is_lead = True
                        confidence += 60
                        reasons.append(f"Item specifics mismatch: {', '.join(mismatch_kws)}")

                    if holo_analysis and holo_analysis.is_likely_parallel:
                        is_lead = True
                        confidence += holo_analysis.confidence * 0.4
                        reasons.append(f"Image analysis: {holo_analysis.reasoning}")

                    if is_lead:
                        price_data = item.get("price", {})
                        price = float(price_data.get("value", 0))
                        buying_options = item.get("buyingOptions", [])

                        lead = {
                            "ebay_item_id": item.get("itemId", ""),
                            "title": title,
                            "seller": item.get("seller", {}).get("username", ""),
                            "current_price": price,
                            "buy_it_now": "FIXED_PRICE" in buying_options,
                            "best_offer": "BEST_OFFER" in buying_options,
                            "listing_type": "fixed" if "FIXED_PRICE" in buying_options else "auction",
                            "image_url": (item.get("image", {}) or {}).get("imageUrl"),
                            "item_url": item.get("itemWebUrl", ""),
                            "hunter_source": "holo_heuristic",
                            "confidence": min(confidence, 95),
                            "alpha_reason": " | ".join(reasons),
                        }

                        self.leads_db.upsert_lead(lead)
                        leads_found += 1
                        logger.info(f"  🌈 HOLO LEAD: {title[:60]}... (confidence: {confidence:.0f}%)")

            self.runs_db.finish_run(run_id, leads_found, items_scanned, errors)

        except Exception as e:
            self.runs_db.fail_run(run_id, str(e))
            logger.exception(f"Holo-Heuristic Engine failed: {e}")
            raise

        summary = {
            "run_id": run_id,
            "leads_found": leads_found,
            "items_scanned": items_scanned,
            "errors": errors,
        }
        logger.info(f"Holo-Heuristic complete: {summary}")
        return summary
