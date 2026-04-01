"""
AlphaCard - Profitability Calculator
Shipping logic, death zone detection, eBay fee calculation, and grading ROI.
"""

import logging
from dataclasses import dataclass
from enum import Enum

logger = logging.getLogger("alphacard.profitability")


class ShippingTier(Enum):
    ESE = ("ese", 0.63, "eBay Standard Envelope", 20.00)
    BMWT = ("bmwt", 4.50, "Bubble Mailer w/ Tracking", 50.00)
    TRACKED = ("tracked", 8.00, "Tracked Package", 999999)

    def __init__(self, code: str, cost: float, label: str, max_value: float):
        self.code = code
        self.cost = cost
        self.label = label
        self.max_value = max_value


@dataclass
class ProfitAnalysis:
    # Inputs
    buy_price: float
    estimated_sale_price: float
    shipping_tier: ShippingTier

    # Costs
    shipping_cost: float
    ebay_final_value_fee: float
    ebay_payment_processing: float
    total_fees: float

    # Results
    gross_profit: float
    net_profit: float
    roi_pct: float
    margin_pct: float

    # Flags
    is_death_zone: bool
    is_profitable: bool
    grade_candidate: bool
    grading_roi: float  # Additional profit if graded PSA 10

    # Recommendations
    recommendation: str
    suggested_offer: float  # If best offer, what to offer


class ProfitCalculator:
    """
    Calculates all-in profitability for a card flip.
    
    eBay Fee Structure (as of 2024):
    - Final Value Fee: 13.25% (Sports Trading Cards category)
    - Payment Processing: $0.30 per order
    - Promoted Listings (optional): 2-5%
    - Sales Tax: Handled by eBay (not our cost)
    
    Shipping Tiers:
    - ESE (eBay Standard Envelope): $0.63 - Cards under $20
    - BMWT (Bubble Mailer w/ Tracking): ~$4.50 - Cards $20-$50
    - Tracked Package: ~$8.00 - Cards over $50
    
    Death Zone: $20-$25 value
    - ESE maxes out at $20 in coverage
    - BMWT adds $3.87 in shipping cost
    - A $22 card shipped BMWT loses ~$4 vs ESE
    """

    FINAL_VALUE_FEE_RATE = 0.1325  # 13.25%
    PAYMENT_PROCESSING_FEE = 0.30
    PROMOTED_LISTING_RATE = 0.03  # Optional, conservative estimate

    DEATH_ZONE_LOW = 20.00
    DEATH_ZONE_HIGH = 25.00

    GRADING_COST_PSA = 18.00  # PSA economy
    GRADING_COST_BGS = 20.00
    PSA_10_MULTIPLIER = 2.5  # Conservative: PSA 10 averages 2.5x raw
    MIN_GRADING_PROFIT = 50.00  # Only grade if profit > $50

    def determine_shipping(self, estimated_value: float) -> ShippingTier:
        """Determine the optimal shipping tier."""
        if estimated_value < self.DEATH_ZONE_LOW:
            return ShippingTier.ESE
        elif estimated_value < 50:
            return ShippingTier.BMWT
        else:
            return ShippingTier.TRACKED

    def calculate(
        self,
        buy_price: float,
        estimated_sale_price: float,
        include_promoted: bool = False,
        graded_price: float = None,  # PSA 10 comp price
    ) -> ProfitAnalysis:
        """
        Calculate full profitability analysis for a card.
        """
        # Shipping
        shipping_tier = self.determine_shipping(estimated_sale_price)
        shipping_cost = shipping_tier.cost

        # eBay fees
        fvf = estimated_sale_price * self.FINAL_VALUE_FEE_RATE
        processing = self.PAYMENT_PROCESSING_FEE
        promoted = estimated_sale_price * self.PROMOTED_LISTING_RATE if include_promoted else 0

        total_fees = round(fvf + processing + promoted + shipping_cost, 2)

        # Profit
        gross_profit = round(estimated_sale_price - buy_price, 2)
        net_profit = round(estimated_sale_price - buy_price - total_fees, 2)
        roi_pct = round((net_profit / buy_price * 100) if buy_price > 0 else 0, 2)
        margin_pct = round((net_profit / estimated_sale_price * 100) if estimated_sale_price > 0 else 0, 2)

        # Death zone check
        is_death_zone = self.DEATH_ZONE_LOW <= estimated_sale_price <= self.DEATH_ZONE_HIGH

        # Grading ROI
        if graded_price is None:
            graded_price = estimated_sale_price * self.PSA_10_MULTIPLIER

        grading_profit = graded_price - buy_price - self.GRADING_COST_PSA - total_fees
        grade_candidate = grading_profit > self.MIN_GRADING_PROFIT

        # Recommendation
        recommendation = self._generate_recommendation(
            net_profit, roi_pct, is_death_zone, grade_candidate,
            estimated_sale_price, buy_price, grading_profit
        )

        # Suggested offer (if Best Offer)
        target_roi = 0.40  # Target 40% ROI
        target_buy = (estimated_sale_price - total_fees) / (1 + target_roi)
        suggested_offer = round(max(target_buy, buy_price * 0.5), 2)

        return ProfitAnalysis(
            buy_price=buy_price,
            estimated_sale_price=estimated_sale_price,
            shipping_tier=shipping_tier,
            shipping_cost=shipping_cost,
            ebay_final_value_fee=round(fvf, 2),
            ebay_payment_processing=processing,
            total_fees=total_fees,
            gross_profit=gross_profit,
            net_profit=net_profit,
            roi_pct=roi_pct,
            margin_pct=margin_pct,
            is_death_zone=is_death_zone,
            is_profitable=net_profit > 0,
            grade_candidate=grade_candidate,
            grading_roi=round(grading_profit, 2),
            recommendation=recommendation,
            suggested_offer=suggested_offer,
        )

    def _generate_recommendation(
        self, net_profit, roi_pct, is_death_zone, grade_candidate,
        sale_price, buy_price, grading_profit
    ) -> str:
        """Generate a human-readable recommendation."""
        if is_death_zone:
            return (
                f"⚠️ DEATH ZONE (${sale_price:.2f}). "
                f"BMWT shipping eats ${ShippingTier.BMWT.cost - ShippingTier.ESE.cost:.2f} extra. "
                f"Net profit only ${net_profit:.2f}. Consider negotiating below $20 or above $25."
            )

        if net_profit < 0:
            return f"❌ UNPROFITABLE. Loss of ${abs(net_profit):.2f}. Pass."

        if grade_candidate:
            return (
                f"🏆 GRADE CANDIDATE. Quick flip: ${net_profit:.2f} profit. "
                f"But PSA 10 could yield ${grading_profit:.2f} profit. "
                f"Submit to PSA if card condition is mint."
            )

        if roi_pct >= 100:
            return f"🔥 EXCELLENT FLIP. ${net_profit:.2f} profit ({roi_pct:.0f}% ROI). BUY NOW."

        if roi_pct >= 50:
            return f"✅ GOOD FLIP. ${net_profit:.2f} profit ({roi_pct:.0f}% ROI). Buy if condition looks clean."

        if roi_pct >= 25:
            return f"👍 DECENT FLIP. ${net_profit:.2f} profit ({roi_pct:.0f}% ROI). Buy if easy sell."

        return f"⚖️ MARGINAL. ${net_profit:.2f} profit ({roi_pct:.0f}% ROI). Only if you're confident in the comp."

    def batch_analyze(self, leads: list[dict]) -> list[dict]:
        """Analyze profitability for a batch of leads."""
        results = []
        for lead in leads:
            buy_price = float(lead.get("current_price", 0))
            sale_price = float(lead.get("median_comp", 0))

            if buy_price <= 0 or sale_price <= 0:
                continue

            analysis = self.calculate(buy_price, sale_price)
            results.append({
                **lead,
                "profit_analysis": {
                    "net_profit": analysis.net_profit,
                    "roi_pct": analysis.roi_pct,
                    "shipping_tier": analysis.shipping_tier.code,
                    "shipping_cost": analysis.shipping_cost,
                    "total_fees": analysis.total_fees,
                    "is_death_zone": analysis.is_death_zone,
                    "grade_candidate": analysis.grade_candidate,
                    "recommendation": analysis.recommendation,
                    "suggested_offer": analysis.suggested_offer,
                },
            })
        return results
