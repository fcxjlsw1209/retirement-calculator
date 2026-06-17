#!/usr/bin/env python3
"""
Scrape Empower and POST results to the Retirement Calculator server.

Usage:
    python scripts/scrape_empower.py --target local
    python scripts/scrape_empower.py --target gcp
"""

import argparse
import asyncio
import os
import sys
from datetime import datetime

import httpx

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env"), override=True)

from backend.empower_client import get_client, EmpowerAuthError, EmpowerAPIError

parser = argparse.ArgumentParser(description="Scrape Empower")
parser.add_argument("--target", choices=["local", "gcp"], required=True,
                    help="Destination: 'local' (http://localhost:8000) or 'gcp' (APP_SERVER from .env)")
args = parser.parse_args()

if args.target == "local":
    SERVER = "http://localhost:8000"
    API_KEY = ""
else:
    SERVER = os.environ["APP_SERVER"]
    API_KEY = os.environ["INGEST_API_KEY"]


async def main():
    print(f"→ target: {args.target}  server: {SERVER}")
    client = get_client()
    try:
        holdings, accounts = await client.fetch_holdings()
    except EmpowerAuthError as e:
        print(f"✗ auth required: {e}")
        sys.exit(1)
    except EmpowerAPIError as e:
        print(f"✗ API error: {e}")
        sys.exit(1)

    print(f"  scraped {len(holdings)} holdings, {len(accounts)} accounts")

    # Serialize datetime/date fields to ISO strings for JSON transport
    from datetime import date
    for acct in accounts:
        if isinstance(acct.get("last_refreshed"), datetime):
            acct["last_refreshed"] = acct["last_refreshed"].isoformat()
        if isinstance(acct.get("closed_date"), date):
            acct["closed_date"] = acct["closed_date"].isoformat()

    headers = {"X-API-Key": API_KEY} if API_KEY else {}
    resp = httpx.post(f"{SERVER}/api/ingest", json={
        "source": "empower",
        "holdings": holdings,
        "accounts": accounts,
    }, headers=headers, timeout=30)
    resp.raise_for_status()
    print(f"✓ {resp.json()}")


if __name__ == "__main__":
    asyncio.run(main())
