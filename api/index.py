import os
import base64
import requests
import json
from http.server import BaseHTTPRequestHandler
from supabase import create_client

# Environment Variables — reuses the same names as the rest of the app
# (EBAY_APP_ID/EBAY_CERT_ID instead of EBAY_CLIENT_ID/SECRET, SUPABASE_SERVICE_KEY
# instead of SUPABASE_KEY) so no new secrets need to be added in Vercel.
EBAY_CLIENT_ID = os.environ.get("EBAY_APP_ID")
EBAY_CLIENT_SECRET = os.environ.get("EBAY_CERT_ID")
SUPABASE_URL = os.environ.get("SUPABASE_URL") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
DISCORD_WEBHOOK_URL = os.environ.get("DISCORD_WEBHOOK_URL")
CRON_SECRET = os.environ.get("CRON_SECRET")


def get_ebay_token():
    auth_str = f"{EBAY_CLIENT_ID}:{EBAY_CLIENT_SECRET}"
    b64_auth = base64.b64encode(auth_str.encode()).decode()

    url = "https://api.ebay.com/identity/v1/oauth2/token"
    headers = {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": f"Basic {b64_auth}"
    }
    data = {
        "grant_type": "client_credentials",
        "scope": "https://api.ebay.com/oauth/api_scope"
    }
    res = requests.post(url, headers=headers, data=data)
    return res.json().get("access_token")


def get_active_queries(supabase):
    """Search queries + price caps now live in the search_queries table,
    editable from the Watchlist page, instead of being hardcoded here."""
    res = supabase.table("search_queries").select("query, max_price").eq("active", True).execute()
    return res.data or []


def search_ebay(token, query, max_price):
    url = "https://api.ebay.com/buy/browse/v1/item_summary/search"

    headers = {
        "Authorization": f"Bearer {token}",
        "X-EBAY-C-MARKETPLACE-ID": "EBAY-US"
    }

    # Params dict so requests properly URL-encodes spaces, commas, and brackets.
    params = {
        "q": query,
        "sort": "newlyListed",
        "limit": 5,
        "filter": f"buyingOptions:{{FIXED_PRICE}},price:[..{max_price}],priceCurrency:USD"
    }

    res = requests.get(url, headers=headers, params=params)
    if res.status_code == 200:
        return res.json().get("itemSummaries", [])
    return []


def send_discord_alert(title, price, url, image_url):
    embed = {
        "title": f"🚨 NEW CARD ALERT: {title}",
        "url": url,
        "color": 3066993,
        "fields": [
            {"name": "Price", "value": f"${price}", "inline": True}
        ],
        "thumbnail": {"url": image_url}
    }
    requests.post(DISCORD_WEBHOOK_URL, json={"embeds": [embed]})


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        # Guard against public/unauthenticated triggering — this endpoint spends
        # eBay API calls and inserts rows on every hit. Vercel Cron automatically
        # sends "Authorization: Bearer $CRON_SECRET" when CRON_SECRET is set.
        if CRON_SECRET:
            auth_header = self.headers.get("Authorization")
            if auth_header != f"Bearer {CRON_SECRET}":
                self.send_response(401)
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Unauthorized"}).encode('utf-8'))
                return

        supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
        token = get_ebay_token()
        alerts_sent = 0

        for target in get_active_queries(supabase):
            items = search_ebay(token, target["query"], target["max_price"])
            for item in items:
                item_id = item.get("itemId")
                title = item.get("title")
                price = item.get("price", {}).get("value", "N/A")
                item_url = item.get("itemWebUrl")
                image_url = item.get("image", {}).get("imageUrl", "")

                # Check if item ID already exists in Supabase
                res = supabase.table("seen_items").select("item_id").eq("item_id", item_id).execute()

                if len(res.data) == 0:
                    # New item found! Insert into DB and trigger alert
                    supabase.table("seen_items").insert({
                        "item_id": item_id,
                        "title": title,
                        "price": str(price)
                    }).execute()

                    send_discord_alert(title, price, item_url, image_url)
                    alerts_sent += 1

        self.send_response(200)
        self.send_header('Content-type', 'application/json')
        self.end_headers()
        response_body = json.dumps({"status": "success", "new_alerts": alerts_sent})
        self.wfile.write(response_body.encode('utf-8'))
