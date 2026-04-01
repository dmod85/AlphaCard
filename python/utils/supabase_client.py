"""
AlphaCard - Supabase Client
Database operations for leads, comps, inventory, and watchlist.
"""

import os
import logging
from datetime import datetime
from typing import Optional

from supabase import create_client, Client
from dotenv import load_dotenv

load_dotenv()
logger = logging.getLogger("alphacard.db")


def get_client() -> Client:
    """Get a Supabase client instance."""
    url = os.getenv("SUPABASE_URL", "")
    key = os.getenv("SUPABASE_SERVICE_KEY", "")
    if not url or not key:
        raise ValueError("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set")
    return create_client(url, key)


class LeadsDB:
    """Operations on the raw_leads table."""

    def __init__(self, client: Optional[Client] = None):
        self.db = client or get_client()

    def upsert_lead(self, lead: dict) -> dict:
        """Insert or update a lead (dedupes on ebay_item_id)."""
        result = (
            self.db.table("raw_leads")
            .upsert(lead, on_conflict="ebay_item_id")
            .execute()
        )
        return result.data[0] if result.data else {}

    def upsert_leads_batch(self, leads: list[dict]) -> list[dict]:
        """Batch upsert leads."""
        if not leads:
            return []
        result = (
            self.db.table("raw_leads")
            .upsert(leads, on_conflict="ebay_item_id")
            .execute()
        )
        return result.data or []

    def get_hot_leads(self, limit: int = 50, sport: Optional[str] = None) -> list[dict]:
        """Get the highest-confidence new leads."""
        query = self.db.table("v_hot_leads").select("*").limit(limit)
        if sport:
            query = query.eq("sport", sport)
        return query.execute().data or []

    def get_leads_by_status(self, status: str, limit: int = 100) -> list[dict]:
        return (
            self.db.table("raw_leads")
            .select("*")
            .eq("status", status)
            .order("confidence", desc=True)
            .limit(limit)
            .execute()
            .data or []
        )

    def update_status(self, lead_id: str, status: str) -> dict:
        result = (
            self.db.table("raw_leads")
            .update({"status": status, "reviewed_at": datetime.now().isoformat()})
            .eq("id", lead_id)
            .execute()
        )
        return result.data[0] if result.data else {}

    def dismiss_lead(self, lead_id: str) -> dict:
        return self.update_status(lead_id, "dismissed")

    def mark_purchased(self, lead_id: str) -> dict:
        return self.update_status(lead_id, "purchased")

    def get_stats(self) -> dict:
        """Get dashboard stats."""
        leads = self.db.table("raw_leads").select("status, estimated_profit, hunter_source", count="exact").execute()
        rows = leads.data or []
        return {
            "total_leads": len(rows),
            "new_leads": sum(1 for r in rows if r["status"] == "new"),
            "total_potential_profit": sum(
                float(r["estimated_profit"] or 0) for r in rows if r["status"] == "new"
            ),
            "by_hunter": {},
        }


class CompsDB:
    """Operations on the sold_comps table."""

    def __init__(self, client: Optional[Client] = None):
        self.db = client or get_client()

    def upsert_comps(self, comps: list[dict]) -> list[dict]:
        if not comps:
            return []
        result = (
            self.db.table("sold_comps")
            .upsert(comps, on_conflict="ebay_item_id")
            .execute()
        )
        return result.data or []

    def get_comps(
        self,
        player_name: str,
        card_set: Optional[str] = None,
        card_year: Optional[int] = None,
        parallel_type: Optional[str] = None,
        limit: int = 50,
    ) -> list[dict]:
        """Fetch cached comps for a card."""
        query = (
            self.db.table("sold_comps")
            .select("*")
            .ilike("player_name", f"%{player_name}%")
            .eq("is_outlier", False)
            .order("sold_date", desc=True)
            .limit(limit)
        )
        if card_set:
            query = query.ilike("card_set", f"%{card_set}%")
        if card_year:
            query = query.eq("card_year", card_year)
        if parallel_type:
            query = query.ilike("parallel_type", f"%{parallel_type}%")

        return query.execute().data or []


class InventoryDB:
    """Operations on the inventory table."""

    def __init__(self, client: Optional[Client] = None):
        self.db = client or get_client()

    def add_card(self, card: dict) -> dict:
        result = self.db.table("inventory").insert(card).execute()
        return result.data[0] if result.data else {}

    def get_active(self, status: Optional[str] = None) -> list[dict]:
        query = self.db.table("inventory").select("*")
        if status:
            query = query.eq("status", status)
        else:
            query = query.neq("status", "sold")
        return query.order("created_at", desc=True).execute().data or []

    def mark_sold(self, card_id: str, sold_price: float, fees: float, shipping: float) -> dict:
        card = self.db.table("inventory").select("total_cost, grading_cost").eq("id", card_id).execute().data
        if not card:
            return {}
        total_cost = float(card[0]["total_cost"] or 0) + float(card[0]["grading_cost"] or 0)
        net_profit = sold_price - total_cost - fees - shipping
        roi = (net_profit / total_cost * 100) if total_cost > 0 else 0

        result = (
            self.db.table("inventory")
            .update({
                "status": "sold",
                "sold_price": sold_price,
                "sold_date": datetime.now().isoformat(),
                "ebay_fees_paid": fees,
                "shipping_cost": shipping,
                "net_profit": round(net_profit, 2),
                "roi_pct": round(roi, 2),
            })
            .eq("id", card_id)
            .execute()
        )
        return result.data[0] if result.data else {}

    def get_summary(self) -> list[dict]:
        return self.db.table("v_inventory_summary").select("*").execute().data or []


class WatchlistDB:
    """Operations on the player_watchlist table."""

    def __init__(self, client: Optional[Client] = None):
        self.db = client or get_client()

    def get_active(self) -> list[dict]:
        return (
            self.db.table("player_watchlist")
            .select("*")
            .eq("active", True)
            .order("priority", desc=True)
            .execute()
            .data or []
        )

    def add_player(self, player: dict) -> dict:
        result = self.db.table("player_watchlist").insert(player).execute()
        return result.data[0] if result.data else {}


class HunterRunsDB:
    """Track hunter scan runs."""

    def __init__(self, client: Optional[Client] = None):
        self.db = client or get_client()

    def start_run(self, hunter_type: str, config: dict = None) -> str:
        result = (
            self.db.table("hunter_runs")
            .insert({
                "hunter_type": hunter_type,
                "config_used": config or {},
            })
            .execute()
        )
        return result.data[0]["id"] if result.data else ""

    def finish_run(self, run_id: str, leads_found: int, items_scanned: int, errors: int = 0, error_log: list = None):
        self.db.table("hunter_runs").update({
            "finished_at": datetime.now().isoformat(),
            "leads_found": leads_found,
            "items_scanned": items_scanned,
            "errors": errors,
            "error_log": error_log or [],
            "status": "completed",
        }).eq("id", run_id).execute()

    def fail_run(self, run_id: str, error: str):
        self.db.table("hunter_runs").update({
            "finished_at": datetime.now().isoformat(),
            "status": "failed",
            "error_log": [{"error": error, "time": datetime.now().isoformat()}],
        }).eq("id", run_id).execute()
