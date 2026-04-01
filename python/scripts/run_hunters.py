#!/usr/bin/env python3
"""
AlphaCard - Main Orchestrator
Runs all hunters on a configurable schedule.
Usage:
    python -m scripts.run_hunters --once          # Single run
    python -m scripts.run_hunters --schedule      # Continuous scheduled runs
    python -m scripts.run_hunters --hunter typo   # Run specific hunter
"""

import os
import sys
import logging
import argparse
from datetime import datetime

from dotenv import load_dotenv
from rich.console import Console
from rich.table import Table
from rich.panel import Panel

# Add parent to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from utils.ebay_client import EbayClient
from utils.supabase_client import LeadsDB, WatchlistDB, HunterRunsDB, CompsDB
from utils.notifications import NotificationRouter
from hunters.comp_engine import CompEngine
from hunters.typo_hunter import TypoHunter
from hunters.holo_engine import HoloHeuristicEngine
from hunters.stale_sniper import StaleSniper

load_dotenv()
console = Console()

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler("alphacard.log"),
    ],
)
logger = logging.getLogger("alphacard")


def print_banner():
    console.print(Panel.fit(
        "[bold green]╔═══════════════════════════════════════╗[/]\n"
        "[bold green]║     AlphaCard Sourcing Engine v1.0    ║[/]\n"
        "[bold green]║  Arbitrage Bot for Card Reselling     ║[/]\n"
        "[bold green]╚═══════════════════════════════════════╝[/]",
        border_style="green",
    ))


def run_all_hunters(ebay: EbayClient, notify: bool = True):
    """Run all three hunters in sequence."""
    notifier = NotificationRouter() if notify else None
    leads_db = LeadsDB()
    watchlist_db = WatchlistDB()
    runs_db = HunterRunsDB()
    comps_db = CompsDB()
    comp_engine = CompEngine(ebay=ebay, comps_db=comps_db)

    total_leads = 0
    total_scanned = 0
    total_errors = 0
    results = {}

    # 1. Typo Hunter
    console.print("\n[bold cyan]🔤 Running Typo Hunter...[/]")
    try:
        typo = TypoHunter(
            ebay=ebay, leads_db=leads_db, watchlist_db=watchlist_db,
            runs_db=runs_db, comp_engine=comp_engine,
        )
        result = typo.hunt()
        results["typo_hunter"] = result
        total_leads += result["leads_found"]
        total_scanned += result["items_scanned"]
        total_errors += result["errors"]
        console.print(f"  [green]✓ {result['leads_found']} leads from {result['items_scanned']} items[/]")
    except Exception as e:
        console.print(f"  [red]✗ Typo Hunter failed: {e}[/]")
        results["typo_hunter"] = {"error": str(e)}

    # 2. Holo-Heuristic Engine
    console.print("\n[bold magenta]🌈 Running Holo-Heuristic Engine...[/]")
    try:
        holo = HoloHeuristicEngine(
            ebay=ebay, leads_db=leads_db, runs_db=runs_db, comp_engine=comp_engine,
        )
        result = holo.hunt(analyze_images=True)
        results["holo_heuristic"] = result
        total_leads += result["leads_found"]
        total_scanned += result["items_scanned"]
        total_errors += result["errors"]
        console.print(f"  [green]✓ {result['leads_found']} leads from {result['items_scanned']} items[/]")
    except Exception as e:
        console.print(f"  [red]✗ Holo Engine failed: {e}[/]")
        results["holo_heuristic"] = {"error": str(e)}

    # 3. Stale Sniper
    console.print("\n[bold yellow]🎯 Running Stale Sniper...[/]")
    try:
        stale = StaleSniper(
            ebay=ebay, leads_db=leads_db, watchlist_db=watchlist_db,
            runs_db=runs_db, comp_engine=comp_engine,
        )
        result = stale.hunt()
        results["stale_sniper"] = result
        total_leads += result["leads_found"]
        total_scanned += result["items_scanned"]
        total_errors += result["errors"]
        console.print(f"  [green]✓ {result['leads_found']} leads from {result['items_scanned']} items[/]")
    except Exception as e:
        console.print(f"  [red]✗ Stale Sniper failed: {e}[/]")
        results["stale_sniper"] = {"error": str(e)}

    # Summary
    table = Table(title="Scan Summary", show_header=True, header_style="bold")
    table.add_column("Metric", style="cyan")
    table.add_column("Value", style="green", justify="right")
    table.add_row("Total Leads Found", str(total_leads))
    table.add_row("Total Items Scanned", str(total_scanned))
    table.add_row("Total Errors", str(total_errors))
    table.add_row("Timestamp", datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    console.print(table)

    # Send summary notification
    if notifier and total_leads > 0:
        notifier.discord.send_summary({
            "leads_found": total_leads,
            "items_scanned": total_scanned,
            "errors": total_errors,
        })

        # Send individual alerts for high-confidence leads
        hot_leads = leads_db.get_hot_leads(limit=10)
        for lead in hot_leads:
            if float(lead.get("confidence", 0)) >= 70:
                notifier.notify(lead)

    return results


def run_single_hunter(hunter_name: str, ebay: EbayClient):
    """Run a specific hunter."""
    leads_db = LeadsDB()
    watchlist_db = WatchlistDB()
    runs_db = HunterRunsDB()
    comp_engine = CompEngine(ebay=ebay)

    if hunter_name == "typo":
        hunter = TypoHunter(
            ebay=ebay, leads_db=leads_db, watchlist_db=watchlist_db,
            runs_db=runs_db, comp_engine=comp_engine,
        )
        return hunter.hunt()
    elif hunter_name == "holo":
        hunter = HoloHeuristicEngine(
            ebay=ebay, leads_db=leads_db, runs_db=runs_db, comp_engine=comp_engine,
        )
        return hunter.hunt()
    elif hunter_name == "stale":
        hunter = StaleSniper(
            ebay=ebay, leads_db=leads_db, watchlist_db=watchlist_db,
            runs_db=runs_db, comp_engine=comp_engine,
        )
        return hunter.hunt()
    else:
        console.print(f"[red]Unknown hunter: {hunter_name}[/]")
        console.print("Available: typo, holo, stale")
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description="AlphaCard Hunter Orchestrator")
    parser.add_argument("--once", action="store_true", help="Run once and exit")
    parser.add_argument("--schedule", action="store_true", help="Run on schedule")
    parser.add_argument("--hunter", type=str, help="Run a specific hunter (typo, holo, stale)")
    parser.add_argument("--no-notify", action="store_true", help="Disable notifications")
    parser.add_argument(
        "--interval", type=int, default=15,
        help="Schedule interval in minutes (default: 15)",
    )
    args = parser.parse_args()

    print_banner()

    ebay = EbayClient()

    if args.hunter:
        console.print(f"\n[bold]Running single hunter: {args.hunter}[/]")
        result = run_single_hunter(args.hunter, ebay)
        console.print(f"\n[green]Result: {result}[/]")

    elif args.schedule:
        from apscheduler.schedulers.blocking import BlockingScheduler

        scheduler = BlockingScheduler()
        scheduler.add_job(
            run_all_hunters,
            "interval",
            minutes=args.interval,
            args=[ebay, not args.no_notify],
            id="alpha_scan",
            name="AlphaCard Full Scan",
            misfire_grace_time=300,
        )

        console.print(f"\n[bold green]Scheduler started. Running every {args.interval} minutes.[/]")
        console.print("[dim]Press Ctrl+C to stop.[/]\n")

        # Run immediately on start
        run_all_hunters(ebay, notify=not args.no_notify)

        try:
            scheduler.start()
        except (KeyboardInterrupt, SystemExit):
            console.print("\n[yellow]Scheduler stopped.[/]")

    else:
        # Default: run once
        run_all_hunters(ebay, notify=not args.no_notify)

    ebay.close()


if __name__ == "__main__":
    main()
