#!/usr/bin/env python3
"""
AlphaCard - eBay OAuth Token Helper
Interactive script to obtain and refresh eBay API tokens.

Usage:
    python -m scripts.ebay_auth          # Full OAuth flow
    python -m scripts.ebay_auth --refresh # Refresh existing token
    python -m scripts.ebay_auth --test    # Test current token
"""

import os
import sys
import base64
import webbrowser
import argparse
from urllib.parse import urlencode, parse_qs, urlparse

import httpx
from dotenv import load_dotenv, set_key
from rich.console import Console
from rich.panel import Panel

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
load_dotenv()
console = Console()

# Base scope works for Browse API search (client_credentials grant).
# The buy.browse scope is NOT assigned to most new developer accounts
# and will cause an "invalid_scope" error if requested.
# Only request additional scopes if you've confirmed they're assigned
# to your app at: developer.ebay.com/my/keys → OAuth Scopes
APP_SCOPES = [
    "https://api.ebay.com/oauth/api_scope",
]

# User-level scopes (for Phase 4: Inventory API / automated listings)
# These are used with the authorization_code grant, NOT client_credentials.
USER_SCOPES = [
    "https://api.ebay.com/oauth/api_scope",
    "https://api.ebay.com/oauth/api_scope/sell.inventory",
    "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
    "https://api.ebay.com/oauth/api_scope/sell.marketing",
]

ENV_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")


def get_credentials(require_redirect=False):
    app_id = os.getenv("EBAY_APP_ID", "")
    cert_id = os.getenv("EBAY_CERT_ID", "")
    redirect_uri = os.getenv("EBAY_REDIRECT_URI", "")
    env = os.getenv("EBAY_ENVIRONMENT", "PRODUCTION")

    if not all([app_id, cert_id]):
        console.print("[red]Missing eBay credentials in .env file.[/]")
        console.print("Required: EBAY_APP_ID, EBAY_CERT_ID")
        sys.exit(1)

    if require_redirect and not redirect_uri:
        console.print("[red]EBAY_REDIRECT_URI (RuName) is required for user token flow.[/]")
        console.print("Set it up at: [cyan]developer.ebay.com/my/keys → User Tokens[/]")
        sys.exit(1)

    base_url = "https://api.ebay.com" if env == "PRODUCTION" else "https://api.sandbox.ebay.com"
    auth_url = "https://auth.ebay.com" if env == "PRODUCTION" else "https://auth.sandbox.ebay.com"

    return app_id, cert_id, redirect_uri, base_url, auth_url


def get_application_token():
    """Get a client_credentials (application) token — no user consent needed."""
    app_id, cert_id, _, base_url, _ = get_credentials()
    credentials = base64.b64encode(f"{app_id}:{cert_id}".encode()).decode()

    console.print("\n[cyan]Requesting application token (client_credentials)...[/]")

    resp = httpx.post(
        f"{base_url}/identity/v1/oauth2/token",
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": f"Basic {credentials}",
        },
        data={
            "grant_type": "client_credentials",
            "scope": " ".join(APP_SCOPES),
        },
    )

    if resp.status_code == 200:
        data = resp.json()
        token = data["access_token"]
        expires = data["expires_in"]

        # Save to .env
        if os.path.exists(ENV_PATH):
            set_key(ENV_PATH, "EBAY_OAUTH_TOKEN", token)
            console.print(f"[green]Token saved to .env (expires in {expires}s)[/]")
        else:
            console.print(f"\n[yellow]Add this to your .env:[/]")
            console.print(f"EBAY_OAUTH_TOKEN={token[:50]}...")

        return token
    else:
        console.print(f"[red]Failed: {resp.status_code}[/]")
        console.print(resp.text)
        return None


def start_user_consent_flow():
    """Start the OAuth user consent flow for user-level tokens."""
    app_id, _, redirect_uri, _, auth_url = get_credentials(require_redirect=True)

    params = urlencode({
        "client_id": app_id,
        "response_type": "code",
        "redirect_uri": redirect_uri,
        "scope": " ".join(USER_SCOPES),
    })

    consent_url = f"{auth_url}/oauth2/authorize?{params}"
    console.print("\n[cyan]Opening browser for eBay authorization...[/]")
    console.print(f"[dim]URL: {consent_url}[/]")

    webbrowser.open(consent_url)

    console.print("\n[yellow]After authorizing, you'll be redirected. Paste the full redirect URL here:[/]")
    redirect_response = input("> ").strip()

    # Extract the authorization code
    parsed = urlparse(redirect_response)
    params = parse_qs(parsed.query)

    if "code" not in params:
        console.print("[red]No authorization code found in the URL.[/]")
        return

    auth_code = params["code"][0]
    console.print(f"[green]Got authorization code: {auth_code[:20]}...[/]")

    # Exchange for token
    exchange_auth_code(auth_code)


def exchange_auth_code(auth_code: str):
    """Exchange an authorization code for access + refresh tokens."""
    app_id, cert_id, redirect_uri, base_url, _ = get_credentials()
    credentials = base64.b64encode(f"{app_id}:{cert_id}".encode()).decode()

    resp = httpx.post(
        f"{base_url}/identity/v1/oauth2/token",
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": f"Basic {credentials}",
        },
        data={
            "grant_type": "authorization_code",
            "code": auth_code,
            "redirect_uri": redirect_uri,
        },
    )

    if resp.status_code == 200:
        data = resp.json()
        access_token = data["access_token"]
        refresh_token = data.get("refresh_token", "")

        if os.path.exists(ENV_PATH):
            set_key(ENV_PATH, "EBAY_OAUTH_TOKEN", access_token)
            if refresh_token:
                set_key(ENV_PATH, "EBAY_REFRESH_TOKEN", refresh_token)
            console.print("[green]Tokens saved to .env[/]")
        else:
            console.print(Panel(
                f"EBAY_OAUTH_TOKEN={access_token[:60]}...\nEBAY_REFRESH_TOKEN={refresh_token[:60]}...",
                title="Add to .env",
            ))
    else:
        console.print(f"[red]Token exchange failed: {resp.status_code}[/]")
        console.print(resp.text)


def refresh_token():
    """Refresh an existing token."""
    app_id, cert_id, _, base_url, _ = get_credentials()
    current_refresh = os.getenv("EBAY_REFRESH_TOKEN", "")

    if not current_refresh:
        console.print("[yellow]No refresh token found. Running full auth flow...[/]")
        return get_application_token()

    credentials = base64.b64encode(f"{app_id}:{cert_id}".encode()).decode()

    resp = httpx.post(
        f"{base_url}/identity/v1/oauth2/token",
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": f"Basic {credentials}",
        },
        data={
            "grant_type": "refresh_token",
            "refresh_token": current_refresh,
            "scope": " ".join(USER_SCOPES),
        },
    )

    if resp.status_code == 200:
        data = resp.json()
        set_key(ENV_PATH, "EBAY_OAUTH_TOKEN", data["access_token"])
        console.print(f"[green]Token refreshed (expires in {data['expires_in']}s)[/]")
    else:
        console.print(f"[red]Refresh failed: {resp.status_code}. Try full auth flow.[/]")


def test_token():
    """Test the current token with a simple API call."""
    token = os.getenv("EBAY_OAUTH_TOKEN", "")
    env = os.getenv("EBAY_ENVIRONMENT", "PRODUCTION")
    base_url = "https://api.ebay.com" if env == "PRODUCTION" else "https://api.sandbox.ebay.com"

    if not token:
        console.print("[red]No token found in .env[/]")
        return

    console.print("[cyan]Testing token...[/]")
    resp = httpx.get(
        f"{base_url}/buy/browse/v1/item_summary/search",
        params={"q": "2024 Prizm football", "limit": "1"},
        headers={
            "Authorization": f"Bearer {token}",
            "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
        },
    )

    if resp.status_code == 200:
        data = resp.json()
        total = data.get("total", 0)
        console.print(f"[green]Token is valid. Found {total} results for test query.[/]")
        if data.get("itemSummaries"):
            item = data["itemSummaries"][0]
            console.print(f"  Sample: {item.get('title', 'N/A')[:60]}")
            console.print(f"  Price: ${item.get('price', {}).get('value', '?')}")
    elif resp.status_code == 401:
        console.print("[red]Token expired or invalid. Run with --refresh to renew.[/]")
    else:
        console.print(f"[red]API error: {resp.status_code}[/]")
        console.print(resp.text[:200])


def main():
    parser = argparse.ArgumentParser(description="eBay OAuth Token Helper")
    parser.add_argument("--refresh", action="store_true", help="Refresh existing token")
    parser.add_argument("--test", action="store_true", help="Test current token")
    parser.add_argument("--user", action="store_true", help="User consent flow (for user-level access)")
    args = parser.parse_args()

    console.print(Panel.fit(
        "[bold green]AlphaCard — eBay OAuth Helper[/]",
        border_style="green",
    ))

    if args.test:
        test_token()
    elif args.refresh:
        refresh_token()
    elif args.user:
        start_user_consent_flow()
    else:
        # Default: get application token (simplest)
        get_application_token()


if __name__ == "__main__":
    main()
