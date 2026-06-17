"""
Ingest layer: takes pre-scraped data and writes to the local DB.

Decoupled from scraper code so the same logic works whether data comes
from a local scraper (sync.py) or a remote HTTP POST (/api/ingest).
"""

from typing import Dict, List, Optional

from backend import db
from backend.checks import run_checks


def ingest_empower(holdings: List[Dict], accounts: List[Dict]) -> int:
    total = sum(h["value_usd"] for h in holdings)
    count = len(holdings)
    db.upsert_holdings("empower", holdings)
    # Empower sometimes returns the same account name twice (e.g. a 401k linked under two
    # Vanguard profiles). Deduplicate by name, keeping the entry with the highest balance.
    deduped: Dict[str, Dict] = {}
    for a in accounts:
        name = a.get("name", "")
        if name not in deduped or a.get("balance", 0) > deduped[name].get("balance", 0):
            deduped[name] = a
    accounts = list(deduped.values())
    db.upsert_accounts("empower", accounts)
    db.save_snapshot("empower", holdings, total, holdings_count=count)

    holdings_by_acct: Dict[str, List[Dict]] = {}
    for h in holdings:
        name = h.get("account_name")
        if name:
            holdings_by_acct.setdefault(name, []).append(h)
    for acct in accounts:
        acct_holdings = holdings_by_acct.get(acct["name"], [])
        db.save_snapshot(
            "empower", acct_holdings, acct["balance"],
            account_name=acct["name"], account_type=acct["account_type"],
            holdings_count=len(acct_holdings),
        )

    warnings = run_checks("empower", count)
    db.write_sync_log("empower", count, total, warnings)
    return count


