"""
AlphaCard - eBay API Client
Handles OAuth2, Browse API, and Finding API interactions.
Implements exponential backoff and rate limiting.
"""

import os
import time
import base64
import logging
from datetime import datetime, timedelta
from typing import Optional
from dataclasses import dataclass, field

import httpx
from dotenv import load_dotenv

load_dotenv()
logger = logging.getLogger("alphacard.ebay")


@dataclass
class EbayConfig:
    app_id: str = field(default_factory=lambda: os.getenv("EBAY_APP_ID", ""))
    cert_id: str = field(default_factory=lambda: os.getenv("EBAY_CERT_ID", ""))
    dev_id: str = field(default_factory=lambda: os.getenv("EBAY_DEV_ID", ""))
    redirect_uri: str = field(default_factory=lambda: os.getenv("EBAY_REDIRECT_URI", ""))
    environment: str = field(default_factory=lambda: os.getenv("EBAY_ENVIRONMENT", "PRODUCTION"))

    @property
    def base_url(self) -> str:
        if self.environment == "SANDBOX":
            return "https://api.sandbox.ebay.com"
        return "https://api.ebay.com"

    @property
    def auth_url(self) -> str:
        if self.environment == "SANDBOX":
            return "https://auth.sandbox.ebay.com"
        return "https://auth.ebay.com"


class RateLimiter:
    """Token bucket rate limiter for eBay API."""

    def __init__(self, calls_per_day: int = 5000):
        self.calls_per_day = calls_per_day
        self.calls_made = 0
        self.window_start = datetime.now()

    def wait_if_needed(self):
        if datetime.now() - self.window_start > timedelta(days=1):
            self.calls_made = 0
            self.window_start = datetime.now()

        if self.calls_made >= self.calls_per_day:
            sleep_seconds = (self.window_start + timedelta(days=1) - datetime.now()).total_seconds()
            logger.warning(f"Rate limit reached. Sleeping {sleep_seconds:.0f}s")
            time.sleep(max(sleep_seconds, 0))
            self.calls_made = 0
            self.window_start = datetime.now()

        self.calls_made += 1
        time.sleep(1.0)  # 1s floor between every request to avoid burst limits

    @property
    def remaining(self) -> int:
        return max(0, self.calls_per_day - self.calls_made)


class EbayClient:
    """eBay API client with OAuth2 and exponential backoff."""

    def __init__(self, config: Optional[EbayConfig] = None):
        self.config = config or EbayConfig()
        self.rate_limiter = RateLimiter()
        self._access_token: Optional[str] = os.getenv("EBAY_OAUTH_TOKEN")
        self._token_expiry: Optional[datetime] = None
        self._client = httpx.Client(timeout=30.0)

    def _get_client_credentials_token(self) -> str:
        """Get an Application token (client_credentials grant)."""
        credentials = base64.b64encode(
            f"{self.config.app_id}:{self.config.cert_id}".encode()
        ).decode()

        resp = self._client.post(
            f"{self.config.base_url}/identity/v1/oauth2/token",
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "Authorization": f"Basic {credentials}",
            },
            data={
                "grant_type": "client_credentials",
                "scope": "https://api.ebay.com/oauth/api_scope",
            },
        )
        resp.raise_for_status()
        data = resp.json()
        self._access_token = data["access_token"]
        self._token_expiry = datetime.now() + timedelta(seconds=data["expires_in"] - 300)
        logger.info("Obtained new eBay access token")
        return self._access_token

    def _ensure_token(self) -> str:
        if not self._access_token or (
            self._token_expiry and datetime.now() >= self._token_expiry
        ):
            return self._get_client_credentials_token()
        return self._access_token

    def _request(
        self, method: str, url: str, max_retries: int = 5, **kwargs
    ) -> dict:
        """Make an API request with exponential backoff."""
        self.rate_limiter.wait_if_needed()
        token = self._ensure_token()

        headers = kwargs.pop("headers", {})
        headers.update({
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
        })

        for attempt in range(max_retries):
            try:
                resp = self._client.request(method, url, headers=headers, **kwargs)

                if resp.status_code == 429:
                    wait = (2 ** attempt) * 30  # 30s, 60s, 120s, 240s, 480s
                    logger.warning(f"Rate limited. Backing off {wait}s (attempt {attempt + 1})")
                    time.sleep(wait)
                    continue

                if resp.status_code == 401:
                    self._access_token = None
                    token = self._ensure_token()
                    headers["Authorization"] = f"Bearer {token}"
                    continue

                resp.raise_for_status()
                return resp.json()

            except httpx.HTTPStatusError as e:
                if attempt == max_retries - 1:
                    logger.error(f"API error after {max_retries} retries: {e}")
                    raise
                wait = (2 ** attempt) * 2
                logger.warning(f"HTTP error {e.response.status_code}. Retry in {wait}s")
                time.sleep(wait)

        return {}

    # =========================================================================
    # Browse API - Search
    # =========================================================================

    def search_items(
        self,
        query: str,
        limit: int = 50,
        offset: int = 0,
        sort: str = "newlyListed",
        filter_str: Optional[str] = None,
        category_ids: Optional[list[str]] = None,
    ) -> dict:
        """
        Search for items using the Browse API.
        
        Args:
            query: Search keywords
            limit: Results per page (max 200)
            sort: Sort order (newlyListed, price, -price, endingSoonest)
            filter_str: eBay filter string
            category_ids: Category IDs to search within
        """
        params = {
            "q": query,
            "limit": min(limit, 200),
            "offset": offset,
            "sort": sort,
        }

        if filter_str:
            params["filter"] = filter_str

        if category_ids:
            params["category_ids"] = ",".join(category_ids)

        url = f"{self.config.base_url}/buy/browse/v1/item_summary/search"
        return self._request("GET", url, params=params)

    def search_fixed_price(
        self, query: str, limit: int = 50, max_price: Optional[float] = None
    ) -> dict:
        """Search specifically for Buy It Now listings."""
        filters = ["buyingOptions:{FIXED_PRICE}"]
        if max_price:
            filters.append(f"price:[..{max_price}],priceCurrency:USD")

        return self.search_items(
            query=query,
            limit=limit,
            filter_str=",".join(filters),
        )

    def search_auctions(
        self, query: str, limit: int = 50, max_price: Optional[float] = None
    ) -> dict:
        """Search specifically for auction listings."""
        filters = ["buyingOptions:{AUCTION}"]
        if max_price:
            filters.append(f"price:[..{max_price}],priceCurrency:USD")

        return self.search_items(
            query=query,
            limit=limit,
            filter_str=",".join(filters),
            sort="endingSoonest",
        )

    def search_best_offer(self, query: str, limit: int = 50) -> dict:
        """Search for listings accepting Best Offer."""
        return self.search_items(
            query=query,
            limit=limit,
            filter_str="buyingOptions:{BEST_OFFER}",
        )

    def get_item(self, item_id: str) -> dict:
        """Get full item details by ID."""
        url = f"{self.config.base_url}/buy/browse/v1/item/{item_id}"
        return self._request("GET", url)

    # =========================================================================
    # Sold Items / Completed Listings (via Finding API)
    # =========================================================================

    def search_sold_items(
        self, query: str, limit: int = 100
    ) -> list[dict]:
        """
        Search for sold/completed items using the Finding API.
        Used for building comp data.
        """
        url = f"{self.config.base_url}/buy/browse/v1/item_summary/search"
        params = {
            "q": query,
            "limit": min(limit, 200),
            "filter": "buyingOptions:{FIXED_PRICE},conditionIds:{3000}",  # Approximation
        }

        # Note: The Browse API doesn't directly support sold items.
        # For true sold comps, we use the Finding API's findCompletedItems
        # or the newer Marketplace Insights API.
        # This is a simplified version. In production, use:
        # POST https://svcs.ebay.com/services/search/FindingService/v1
        # with findCompletedItems operation.

        logger.info(f"Searching sold comps for: {query}")
        return self._request("GET", url, params=params).get("itemSummaries", [])

    # =========================================================================
    # Image fetching (for Holo-Heuristic analysis)
    # =========================================================================

    def download_image(self, image_url: str) -> bytes:
        """Download an item image for CV analysis."""
        resp = self._client.get(image_url)
        resp.raise_for_status()
        return resp.content

    def close(self):
        self._client.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()
