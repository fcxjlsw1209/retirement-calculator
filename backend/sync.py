from __future__ import annotations

"""
Sync orchestrator. Runs Empower data source and writes results to SQLite.
"""

import asyncio
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

from backend import db, ingest
from backend.empower_client import get_client, EmpowerAuthError, EmpowerAPIError


@dataclass
class SourceResult:
    status: str           # 'ok' | 'error' | 'auth_required' | 'skipped'
    synced_at: Optional[datetime] = None
    last_ok: Optional[datetime] = None
    error: Optional[str] = None
    rows: int = 0


@dataclass
class SyncResult:
    empower: SourceResult = field(default_factory=lambda: SourceResult("pending"))
    reauth_required: bool = False

    def any_ok(self) -> bool:
        return self.empower.status == "ok"


async def run_sync(skip_empower: bool = False) -> SyncResult:
    result = SyncResult()

    if skip_empower:
        result.empower = SourceResult(status="skipped")
    else:
        try:
            client = get_client()
            holdings, accounts = await client.fetch_holdings()
            rows = ingest.ingest_empower(holdings, accounts)
            result.empower = SourceResult(
                status="ok",
                synced_at=datetime.utcnow(),
                rows=rows,
            )
        except EmpowerAuthError as e:
            result.empower = SourceResult(status="auth_required", error=str(e))
            result.reauth_required = True
            return result
        except EmpowerAPIError as e:
            result.empower = SourceResult(status="error", error=str(e))

    asyncio.create_task(_update_attribution())

    return result


async def _update_attribution():
    """Generate AI attribution in the background after sync completes."""
    try:
        from backend.attribution import compute_attribution, generate_explanation

        holdings = db.get_all_holdings()
        result = compute_attribution(holdings)
        if result is None:
            return

        generate_explanation(result)
    except Exception as e:
        print(f"Attribution update failed (non-critical): {e}")
