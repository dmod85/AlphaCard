"""
AlphaCard - Notification System
Real-time alerts via Discord webhooks and Pushover push notifications.
"""

import os
import logging
from typing import Optional

import httpx
from dotenv import load_dotenv

load_dotenv()
logger = logging.getLogger("alphacard.notifications")


class DiscordNotifier:
    """Send alerts to a Discord channel via webhook."""

    def __init__(self, webhook_url: Optional[str] = None):
        self.webhook_url = webhook_url or os.getenv("DISCORD_WEBHOOK_URL", "")
        self.client = httpx.Client(timeout=10)

    def send_lead_alert(self, lead: dict) -> bool:
        if not self.webhook_url:
            logger.warning("Discord webhook URL not configured")
            return False

        profit = lead.get("estimated_profit", 0)
        confidence = lead.get("confidence", 0)
        hunter = lead.get("hunter_source", "unknown")

        # Emoji based on hunter type
        emoji_map = {
            "typo_hunter": "🔤",
            "holo_heuristic": "🌈",
            "stale_sniper": "🎯",
            "manual": "👤",
        }
        emoji = emoji_map.get(hunter, "📦")

        # Color based on profit tier
        if profit >= 20:
            color = 0x00FF00  # Green - excellent
        elif profit >= 10:
            color = 0xFFD700  # Gold - good
        elif profit >= 5:
            color = 0xFFA500  # Orange - decent
        else:
            color = 0x808080  # Gray - marginal

        embed = {
            "embeds": [{
                "title": f"{emoji} New Lead: {lead.get('title', 'Unknown')[:80]}",
                "color": color,
                "fields": [
                    {"name": "💰 Price", "value": f"${lead.get('current_price', 0):.2f}", "inline": True},
                    {"name": "📊 Median Comp", "value": f"${lead.get('median_comp', 0):.2f}", "inline": True},
                    {"name": "📈 Est. Profit", "value": f"${profit:.2f}", "inline": True},
                    {"name": "🎯 Confidence", "value": f"{confidence:.0f}%", "inline": True},
                    {"name": "🏷️ Hunter", "value": hunter.replace("_", " ").title(), "inline": True},
                    {"name": "🏈 Sport", "value": lead.get("sport", "unknown").upper(), "inline": True},
                    {"name": "📝 Reason", "value": lead.get("alpha_reason", "N/A")[:200], "inline": False},
                ],
                "url": lead.get("item_url", ""),
                "thumbnail": {"url": lead.get("image_url", "")} if lead.get("image_url") else None,
                "footer": {"text": f"AlphaCard • {lead.get('player_name', '')}"},
            }]
        }

        # Clean None thumbnails
        if not embed["embeds"][0].get("thumbnail", {}).get("url"):
            embed["embeds"][0].pop("thumbnail", None)

        try:
            resp = self.client.post(self.webhook_url, json=embed)
            resp.raise_for_status()
            logger.info(f"Discord alert sent for {lead.get('ebay_item_id')}")
            return True
        except Exception as e:
            logger.error(f"Discord notification failed: {e}")
            return False

    def send_summary(self, stats: dict) -> bool:
        """Send a daily/run summary to Discord."""
        if not self.webhook_url:
            return False

        embed = {
            "embeds": [{
                "title": "📊 AlphaCard Scan Summary",
                "color": 0x5865F2,
                "fields": [
                    {"name": "New Leads", "value": str(stats.get("leads_found", 0)), "inline": True},
                    {"name": "Items Scanned", "value": str(stats.get("items_scanned", 0)), "inline": True},
                    {"name": "Errors", "value": str(stats.get("errors", 0)), "inline": True},
                ],
                "footer": {"text": "AlphaCard Engine"},
            }]
        }

        try:
            resp = self.client.post(self.webhook_url, json=embed)
            resp.raise_for_status()
            return True
        except Exception as e:
            logger.error(f"Discord summary failed: {e}")
            return False


class PushoverNotifier:
    """Send push notifications via Pushover (for urgent BIN deals)."""

    API_URL = "https://api.pushover.net/1/messages.json"

    def __init__(
        self,
        user_key: Optional[str] = None,
        app_token: Optional[str] = None,
    ):
        self.user_key = user_key or os.getenv("PUSHOVER_USER_KEY", "")
        self.app_token = app_token or os.getenv("PUSHOVER_APP_TOKEN", "")
        self.client = httpx.Client(timeout=10)

    def send_urgent_alert(self, lead: dict) -> bool:
        """Send a high-priority push notification for BIN deals."""
        if not self.user_key or not self.app_token:
            logger.warning("Pushover not configured")
            return False

        profit = lead.get("estimated_profit", 0)
        message = (
            f"🚨 BIN DEAL: {lead.get('player_name', 'Unknown')}\n"
            f"${lead.get('current_price', 0):.2f} → ${lead.get('median_comp', 0):.2f} comp\n"
            f"Profit: ${profit:.2f} ({lead.get('roi_pct', 0):.0f}% ROI)\n"
            f"Source: {lead.get('hunter_source', 'unknown')}"
        )

        data = {
            "token": self.app_token,
            "user": self.user_key,
            "title": f"AlphaCard: ${profit:.2f} Flip",
            "message": message,
            "url": lead.get("item_url", ""),
            "url_title": "Open on eBay",
            "priority": 1 if profit >= 15 else 0,
            "sound": "cashregister" if profit >= 15 else "pushover",
        }

        try:
            resp = self.client.post(self.API_URL, data=data)
            resp.raise_for_status()
            logger.info(f"Pushover alert sent for {lead.get('ebay_item_id')}")
            return True
        except Exception as e:
            logger.error(f"Pushover notification failed: {e}")
            return False


class NotificationRouter:
    """Routes notifications to the appropriate channels based on lead quality."""

    def __init__(self):
        self.discord = DiscordNotifier()
        self.pushover = PushoverNotifier()

    def notify(self, lead: dict):
        """
        Route a lead notification:
        - All leads → Discord
        - High-profit BIN deals → Pushover (phone alert)
        """
        # Always send to Discord
        self.discord.send_lead_alert(lead)

        # Send to Pushover for urgent BIN deals
        profit = lead.get("estimated_profit", 0)
        is_bin = lead.get("buy_it_now", False)

        if is_bin and profit >= 10:
            self.pushover.send_urgent_alert(lead)
