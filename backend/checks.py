"""
Sync sanity checks — run after each ingest, results stored in SyncLog.

Checks:
  1. holdings_count_drop: current count vs previous sync for same source dropped >50%
"""

from datetime import date
from typing import List, Optional

from sqlmodel import Session, select

from backend import db


def check_holdings_count_drop(source: str, current_count: int) -> List[str]:
    """Warn if holdings count dropped >50% compared to the previous sync."""
    with Session(db.engine()) as session:
        # Get the most recent aggregate snapshot BEFORE today for this source
        prev = session.exec(
            select(db.Snapshot)
            .where(db.Snapshot.source == source)
            .where(db.Snapshot.account_name == None)  # noqa: E711
            .where(db.Snapshot.snapshot_date < date.today())
            .order_by(db.Snapshot.snapshot_date.desc())
        ).first()

    if prev is None or prev.holdings_count is None:
        return []  # no history to compare against

    prev_count = prev.holdings_count
    if prev_count == 0:
        return []

    drop_pct = (prev_count - current_count) / prev_count
    if drop_pct > 0.5:
        return [
            f"{source} 本次同步只有 {current_count} 条持仓（上次 {prev_count} 条），请检查"
        ]
    return []


def run_checks(source: str, current_count: int) -> List[str]:
    """Run all per-source checks and return combined warnings."""
    warnings: List[str] = []
    warnings.extend(check_holdings_count_drop(source, current_count))
    return warnings
