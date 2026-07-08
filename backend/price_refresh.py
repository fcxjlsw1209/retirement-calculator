"""
Price refresh: fetch latest market prices for all held tickers and
re-write holdings + accounts + snapshot without a new Empower scrape.

Usage:
  python -m backend.price_refresh
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Dict, List, Optional

import yfinance as yf
from sqlmodel import Session, select

from backend import db


# Tickers we know yfinance can't price — skip silently
_SKIP_PATTERNS = [
    r'@',          # RSU / award placeholders  e.g. DASH@
    r'\.o@',       # option contracts          e.g. AMD260710C00530000.o@530.0
    r'^[0-9]',     # numeric CUSIP-style ids   e.g. 21254S404, 94SX0
    r'SPAXX',      # Fidelity money-market (fixed $1 NAV, not on yfinance)
    r'SPCK',       # internal placeholder
]

def _should_skip(ticker: str) -> bool:
    return any(re.search(p, ticker) for p in _SKIP_PATTERNS)


def fetch_prices(tickers: List[str]) -> Dict[str, float]:
    """Return {ticker: latest_price} for tickers yfinance can price."""
    fetchable = [t for t in tickers if not _should_skip(t)]
    if not fetchable:
        return {}

    print(f"  Fetching prices for {len(fetchable)} tickers via yfinance...")
    data = yf.download(fetchable, period="2d", auto_adjust=True, progress=False)

    prices: Dict[str, float] = {}
    if data.empty:
        return prices

    close = data["Close"] if "Close" in data.columns else data
    latest = close.iloc[-1]

    for t in fetchable:
        val = latest.get(t)
        if val is not None and not (val != val):  # skip NaN
            prices[t] = float(val)

    return prices


def run_price_refresh() -> dict:
    """
    1. Load current holdings from DB
    2. Fetch latest prices
    3. Recompute value_usd = shares * price  (skip if no shares or price unavailable)
    4. Write updated holdings (upsert replaces all empower rows)
    5. Recompute per-account balances and update account table
    6. Save new snapshot
    """
    with Session(db.engine()) as session:
        holdings: List[db.Holding] = session.exec(
            select(db.Holding).where(db.Holding.source == "empower")
        ).all()
        accounts: List[db.Account] = session.exec(
            select(db.Account).where(db.Account.source == "empower")
        ).all()

    if not holdings:
        return {"status": "error", "detail": "No empower holdings in DB"}

    tickers = list({h.ticker for h in holdings if h.ticker})
    prices = fetch_prices(tickers)

    updated = 0
    skipped = 0
    now = datetime.utcnow()

    holding_dicts: List[dict] = []
    for h in holdings:
        d = {
            "ticker": h.ticker,
            "asset_class": h.asset_class,
            "name": h.name,
            "value_usd": h.value_usd,
            "shares": h.shares,
            "cost_basis": h.cost_basis,
            "account_name": h.account_name,
            "account_type": h.account_type,
            "synced_at": now,
        }
        if h.ticker and h.shares and h.ticker in prices:
            new_value = h.shares * prices[h.ticker]
            d["value_usd"] = new_value
            updated += 1
        else:
            skipped += 1
        holding_dicts.append(d)

    # Scale account balances proportionally to the overall holdings change.
    # "In Multiple Accounts" holdings can't be mapped back to individual accounts,
    # so we avoid reconstructing per-account totals from holdings. Instead we compute
    # the ratio of new holdings total to old holdings total and apply it uniformly.
    old_total = sum(h.value_usd for h in holdings)
    new_total = sum(d["value_usd"] for d in holding_dicts)
    scale = new_total / old_total if old_total > 0 else 1.0

    account_dicts: List[dict] = []
    for a in accounts:
        account_dicts.append({
            "user_account_id": a.user_account_id,
            "firm_name": a.firm_name,
            "name": a.name,
            "account_type": a.account_type,
            "balance": a.balance * scale,
            "last_refreshed": now,
            "closed_date": a.closed_date,
            "synced_at": now,
        })

    # Persist
    db.upsert_holdings("empower", holding_dicts)
    db.upsert_accounts("empower", account_dicts)

    total = sum(d["value_usd"] for d in holding_dicts)
    db.save_snapshot("empower", holding_dicts, total, holdings_count=len(holding_dicts))

    # Per-account snapshots
    holdings_by_acct: Dict[str, List[dict]] = {}
    for d in holding_dicts:
        name = d.get("account_name")
        if name:
            holdings_by_acct.setdefault(name, []).append(d)
    for a in account_dicts:
        acct_h = holdings_by_acct.get(a["name"], [])
        db.save_snapshot(
            "empower", acct_h, a["balance"],
            account_name=a["name"], account_type=a["account_type"],
            holdings_count=len(acct_h),
        )

    db.write_sync_log("empower", len(holding_dicts), total, [])

    return {
        "status": "ok",
        "total_holdings": len(holding_dicts),
        "prices_updated": updated,
        "prices_skipped": skipped,
        "prices_fetched": len(prices),
        "total_value_usd": round(total, 2),
    }


if __name__ == "__main__":
    result = run_price_refresh()
    print(result)
