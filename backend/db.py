from __future__ import annotations

"""
SQLite database with WAL mode.

Schema:
  holdings  — current state per source (cleared and rewritten on each sync)
  snapshots — one allocation snapshot per sync (append-only, drives attribution)
  cash_flow — manual money-in/money-out entries per account (for performance calc)
  benchmark_cache — daily SPY/AGG returns (avoid hammering Yahoo Finance)
  attribution_cache — latest Claude explanation (generated async after sync)
  price_history — daily SP500/NASDAQ closes for 5Y chart (backfilled on first run)
  market_signals — daily VIX/VXN/F&G/RSI readings for Market Pulse page
  retirement_account_tag — user-configured account → is_retirement mapping (global)
  retirement_scenario — named retirement planning scenarios with all calculator params
"""

from datetime import date, datetime, timedelta
from typing import Dict, List, Optional
import json

from sqlmodel import Field, Session, SQLModel, create_engine, text, select
from backend.config import db_path


# ── Models ────────────────────────────────────────────────────────────────────

class Account(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    source: str                      # 'empower'
    user_account_id: int = Field(index=True)   # Empower userAccountId
    firm_name: str                   # 'Fidelity Investments'
    name: str                        # 'Brokerage - Ending in 1234'
    account_type: str                # 'IRA - Roth' | '401K' | 'Investment' | ...
    balance: float                   # from getAccounts2 (accurate)
    last_refreshed: Optional[datetime] = None  # Empower lastRefreshed timestamp
    closed_date: Optional[date] = None          # Empower closedDate (non-empty = closed)
    synced_at: datetime = Field(default_factory=datetime.utcnow)


class Holding(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    source: str                     # 'empower'
    ticker: Optional[str] = None    # ticker symbol or None for funds
    asset_class: str                # 'US Equity' | 'International' | 'Bond' | 'Cash' | 'Unknown'
    name: Optional[str] = None      # human-readable name
    value_usd: float
    shares: Optional[float] = None
    cost_basis: Optional[float] = None
    account_name: Optional[str] = None  # sub-account name (Empower only)
    account_type: Optional[str] = None  # '401(k)' | 'IRA' | 'Roth IRA' | 'Brokerage' | ...
    synced_at: datetime = Field(default_factory=datetime.utcnow)


class Snapshot(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    snapshot_date: date = Field(default_factory=date.today)
    source: str
    account_name: Optional[str] = None  # None = whole-source aggregate
    account_type: Optional[str] = None
    allocation_json: str            # JSON: {"US Equity": 0.58, "Bond": 0.22, ...}
    total_value_usd: float
    holdings_count: Optional[int] = None   # number of holdings at sync time
    created_at: datetime = Field(default_factory=datetime.utcnow)


class MarketQuote(SQLModel, table=True):
    """Indicative prices kept separate from custodian balances and history."""
    ticker: str = Field(primary_key=True)
    price: float
    market_date: date
    fetched_at: datetime = Field(default_factory=datetime.utcnow)


def get_market_quotes() -> Dict[str, MarketQuote]:
    with Session(engine()) as session:
        return {q.ticker: q for q in session.exec(select(MarketQuote)).all()}


def save_market_quotes(quotes: List[MarketQuote]) -> None:
    with Session(engine()) as session:
        for quote in quotes:
            old = session.get(MarketQuote, quote.ticker)
            if old is None or old.market_date <= quote.market_date:
                session.merge(quote)
        session.commit()


class SyncLog(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    synced_at: datetime = Field(default_factory=datetime.utcnow)
    source: str
    holdings_count: int
    total_value_usd: float
    status: str                 # 'ok' | 'warning'
    warnings_json: str = "[]"  # JSON list[str]


class CashFlow(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    account_name: str = Field(index=True)   # matches Account.name
    date: date
    amount_usd: float                        # positive = money in, negative = money out
    note: Optional[str] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)


class BenchmarkCache(SQLModel, table=True):
    cache_date: date = Field(primary_key=True)
    spy_return: Optional[float] = None
    agg_return: Optional[float] = None
    fetched_at: datetime = Field(default_factory=datetime.utcnow)


class AttributionCache(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    generated_at: datetime = Field(default_factory=datetime.utcnow)
    attribution_text: str           # Claude's Chinese output
    period_start: Optional[date] = None
    period_end: Optional[date] = None


class PriceHistory(SQLModel, table=True):
    record_date: date = Field(primary_key=True)
    sp500_close: float
    ndx_close: float


class MarketSignals(SQLModel, table=True):
    record_date: date = Field(primary_key=True)
    vix: Optional[float] = None
    vxn: Optional[float] = None
    fg: Optional[int] = None          # Fear & Greed 0-100, None if CNN fetch failed
    rsi_sp500: Optional[float] = None # None if < 28 data points
    fetched_at: datetime = Field(default_factory=datetime.utcnow)


class RetirementAccountTag(SQLModel, table=True):
    account_name: str = Field(primary_key=True)
    is_retirement: bool = Field(default=False)


class RetirementScenario(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    current_age: int
    retirement_age: int
    max_age: int
    monthly_contribution: int
    phases_json: str                  # JSON: SpendingPhase[]
    withdrawal_tax_rate: float = Field(default=0.22)
    post_retirement_equity_pct: float = Field(default=0.6)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


# ── Engine + init ──────────────────────────────────────────────────────────────

def get_engine():
    engine = create_engine(f"sqlite:///{db_path()}", echo=False)
    with engine.connect() as conn:
        # WAL mode: allows concurrent reads while a write is in progress
        conn.execute(text("PRAGMA journal_mode=WAL"))
        conn.execute(text("PRAGMA foreign_keys=ON"))
        # Migrations: add columns that may not exist in older DBs
        try:
            conn.execute(text("ALTER TABLE account ADD COLUMN last_refreshed DATETIME"))
            conn.commit()
        except Exception:
            pass  # column already exists
        try:
            conn.execute(text("ALTER TABLE snapshot ADD COLUMN holdings_count INTEGER"))
            conn.commit()
        except Exception:
            pass  # column already exists
        try:
            conn.execute(text("ALTER TABLE account ADD COLUMN closed_date DATE"))
            conn.commit()
        except Exception:
            pass  # column already exists
        try:
            conn.execute(text("ALTER TABLE retirementscenario ADD COLUMN withdrawal_tax_rate REAL NOT NULL DEFAULT 0.22"))
            conn.commit()
        except Exception:
            pass  # column already exists
        try:
            conn.execute(text("ALTER TABLE retirementscenario ADD COLUMN post_retirement_equity_pct REAL NOT NULL DEFAULT 0.6"))
            conn.commit()
        except Exception:
            pass  # column already exists
    return engine


_engine = None

def engine():
    global _engine
    if _engine is None:
        _engine = get_engine()
        SQLModel.metadata.create_all(_engine, checkfirst=True)
    return _engine


def get_session():
    with Session(engine()) as session:
        yield session


# ── Holdings upsert ────────────────────────────────────────────────────────────

def upsert_accounts(source: str, accounts: List[Dict]) -> int:
    """Replace all accounts for a source atomically."""
    with Session(engine()) as session:
        existing = session.exec(select(Account).where(Account.source == source)).all()
        for row in existing:
            session.delete(row)
        rows = [Account(source=source, **a) for a in accounts]
        session.add_all(rows)
        session.commit()
        return len(rows)


def get_all_accounts() -> List[Account]:
    with Session(engine()) as session:
        return session.exec(select(Account)).all()


def upsert_holdings(source: str, holdings: List[Dict]) -> int:
    """
    Replace all holdings for a source atomically.
    Returns number of rows inserted.

    Pattern: DELETE existing rows for this source, then batch INSERT new ones.
    This prevents duplicates across syncs.
    """
    with Session(engine()) as session:
        # Clear existing rows for this source
        existing = session.exec(select(Holding).where(Holding.source == source)).all()
        for row in existing:
            session.delete(row)

        # Insert new rows
        rows = [Holding(source=source, **h) for h in holdings]
        session.add_all(rows)
        session.commit()
        return len(rows)


def save_snapshot(
    source: str,
    holdings: List[Dict],
    total_value: float,
    account_name: Optional[str] = None,
    account_type: Optional[str] = None,
    holdings_count: Optional[int] = None,
):
    """
    Upsert a snapshot for today: one row per (source, account_name, date).
    Same-day syncs overwrite rather than accumulate.
    """
    by_class: Dict[str, float] = {}
    for h in holdings:
        by_class[h["asset_class"]] = by_class.get(h["asset_class"], 0) + h["value_usd"]

    allocation = {k: v / total_value for k, v in by_class.items()} if total_value > 0 else {}
    today = date.today()

    with Session(engine()) as session:
        q = (
            select(Snapshot)
            .where(Snapshot.source == source)
            .where(Snapshot.snapshot_date == today)
        )
        if account_name is None:
            q = q.where(Snapshot.account_name == None)  # noqa: E711
        else:
            q = q.where(Snapshot.account_name == account_name)

        existing = session.exec(q).first()
        if existing:
            existing.total_value_usd = total_value
            existing.allocation_json = json.dumps(allocation)
            existing.account_type = account_type
            existing.holdings_count = holdings_count
            existing.created_at = datetime.utcnow()
        else:
            session.add(Snapshot(
                source=source,
                account_name=account_name,
                account_type=account_type,
                allocation_json=json.dumps(allocation),
                total_value_usd=total_value,
                holdings_count=holdings_count,
            ))
        session.commit()


def get_all_holdings() -> List[Holding]:
    with Session(engine()) as session:
        return session.exec(select(Holding)).all()


def get_latest_snapshot_before(source: str, before_date: date) -> Optional[Snapshot]:
    with Session(engine()) as session:
        results = session.exec(
            select(Snapshot)
            .where(Snapshot.source == source)
            .where(Snapshot.snapshot_date < before_date)
            .order_by(Snapshot.snapshot_date.desc())
        ).first()
        return results


def get_latest_attribution() -> Optional[AttributionCache]:
    with Session(engine()) as session:
        return session.exec(
            select(AttributionCache).order_by(AttributionCache.generated_at.desc())
        ).first()


def save_attribution(text: str, period_start: Optional[date], period_end: Optional[date]):
    with Session(engine()) as session:
        session.add(AttributionCache(
            attribution_text=text,
            period_start=period_start,
            period_end=period_end,
        ))
        session.commit()


def get_snapshot_value_near(
    source: str,
    target_date: date,
    account_name: Optional[str] = None,
) -> Optional[float]:
    """Most recent total_value_usd for (source, account_name) on or before target_date."""
    with Session(engine()) as session:
        q = (
            select(Snapshot)
            .where(Snapshot.source == source)
            .where(Snapshot.snapshot_date <= target_date)
        )
        if account_name is None:
            q = q.where(Snapshot.account_name == None)  # noqa: E711
        else:
            q = q.where(Snapshot.account_name == account_name)
        result = session.exec(q.order_by(Snapshot.snapshot_date.desc())).first()
        return result.total_value_usd if result else None


def get_benchmark_cache(d: date) -> Optional[BenchmarkCache]:
    with Session(engine()) as session:
        return session.get(BenchmarkCache, d)


def save_benchmark_cache(d: date, spy_return: Optional[float], agg_return: Optional[float]):
    with Session(engine()) as session:
        existing = session.get(BenchmarkCache, d)
        if existing:
            existing.spy_return = spy_return
            existing.agg_return = agg_return
            existing.fetched_at = datetime.utcnow()
        else:
            session.add(BenchmarkCache(cache_date=d, spy_return=spy_return, agg_return=agg_return))
        session.commit()


# ── Cash flows ─────────────────────────────────────────────────────────────────

def get_cash_flows(account_name: str) -> List[CashFlow]:
    with Session(engine()) as session:
        return session.exec(
            select(CashFlow)
            .where(CashFlow.account_name == account_name)
            .order_by(CashFlow.date.desc())
        ).all()


def add_cash_flow(account_name: str, cf_date: date, amount_usd: float, note: Optional[str]) -> CashFlow:
    with Session(engine()) as session:
        cf = CashFlow(account_name=account_name, date=cf_date, amount_usd=amount_usd, note=note)
        session.add(cf)
        session.commit()
        session.refresh(cf)
        return cf


def delete_cash_flow(cf_id: int) -> bool:
    with Session(engine()) as session:
        cf = session.get(CashFlow, cf_id)
        if not cf:
            return False
        session.delete(cf)
        session.commit()
        return True


# ── SyncLog ────────────────────────────────────────────────────────────────────

def write_sync_log(source: str, holdings_count: int, total_value: float, warnings: List[str]):
    status = "warning" if warnings else "ok"
    with Session(engine()) as session:
        session.add(SyncLog(
            source=source,
            holdings_count=holdings_count,
            total_value_usd=total_value,
            status=status,
            warnings_json=json.dumps(warnings, ensure_ascii=False),
        ))
        session.commit()


def get_sync_logs(limit: int = 30) -> List[SyncLog]:
    """Return the most recent SyncLog entries, newest first."""
    with Session(engine()) as session:
        logs = session.exec(
            select(SyncLog).order_by(SyncLog.synced_at.desc()).limit(limit)
        ).all()
        return list(logs)


def get_snapshots_in_range(
    account_names: list[str], from_date: date, to_date: date
) -> list[Snapshot]:
    with Session(engine()) as session:
        return session.exec(
            select(Snapshot)
            .where(Snapshot.account_name.in_(account_names))
            .where(Snapshot.snapshot_date >= from_date)
            .where(Snapshot.snapshot_date <= to_date)
            .order_by(Snapshot.account_name, Snapshot.snapshot_date)
        ).all()


def get_earliest_snapshot_date() -> date | None:
    with Session(engine()) as session:
        result = session.exec(
            select(Snapshot)
            .where(Snapshot.account_name != None)  # noqa: E711
            .order_by(Snapshot.snapshot_date.asc())
        ).first()
        return result.snapshot_date if result else None


def get_cash_flows_in_range(
    account_names: list[str], from_date: date, to_date: date
) -> list[CashFlow]:
    with Session(engine()) as session:
        return session.exec(
            select(CashFlow)
            .where(CashFlow.account_name.in_(account_names))
            .where(CashFlow.date >= from_date)
            .where(CashFlow.date <= to_date)
            .order_by(CashFlow.account_name, CashFlow.date)
        ).all()


# ── Market Pulse ───────────────────────────────────────────────────────────────

def count_price_history() -> int:
    with Session(engine()) as session:
        return session.exec(select(PriceHistory)).all().__len__()


def upsert_price_history(rows: list[dict]) -> int:
    """Batch upsert (record_date, sp500_close, ndx_close) rows. Idempotent."""
    with Session(engine()) as session:
        for row in rows:
            existing = session.get(PriceHistory, row["record_date"])
            if existing:
                existing.sp500_close = row["sp500_close"]
                existing.ndx_close = row["ndx_close"]
            else:
                session.add(PriceHistory(**row))
        session.commit()
        return len(rows)


def get_all_price_history() -> list[PriceHistory]:
    with Session(engine()) as session:
        return session.exec(
            select(PriceHistory).order_by(PriceHistory.record_date.asc())
        ).all()


def upsert_market_signals(
    d: date,
    vix: Optional[float],
    vxn: Optional[float],
    fg: Optional[int],
    rsi_sp500: Optional[float],
) -> None:
    with Session(engine()) as session:
        existing = session.get(MarketSignals, d)
        if existing:
            existing.vix = vix
            existing.vxn = vxn
            existing.fg = fg
            existing.rsi_sp500 = rsi_sp500
            existing.fetched_at = datetime.utcnow()
        else:
            session.add(MarketSignals(
                record_date=d, vix=vix, vxn=vxn, fg=fg, rsi_sp500=rsi_sp500,
            ))
        session.commit()


def get_latest_market_signals() -> Optional[MarketSignals]:
    with Session(engine()) as session:
        return session.exec(
            select(MarketSignals).order_by(MarketSignals.record_date.desc())
        ).first()


def get_market_signals_on(d: date) -> Optional[MarketSignals]:
    with Session(engine()) as session:
        return session.get(MarketSignals, d)


def get_market_signals_for_delta(
    latest_date: date,
    days: int = 7,
    tolerance_days: int = 3,
) -> Optional[MarketSignals]:
    """
    Return the closest market signal around latest_date - days.

    Market data skips weekends/holidays and local fetches can miss a day, so a
    strict date lookup makes the UI hide deltas even when useful nearby data
    exists. Keep the window narrow enough that "vs 7d" still means roughly a
    week, and never compare against the latest row itself.
    """
    target = latest_date - timedelta(days=days)
    start = target - timedelta(days=tolerance_days)
    end = min(target + timedelta(days=tolerance_days), latest_date - timedelta(days=1))
    if end < start:
        return None

    with Session(engine()) as session:
        rows = session.exec(
            select(MarketSignals)
            .where(MarketSignals.record_date >= start)
            .where(MarketSignals.record_date <= end)
        ).all()

    if not rows:
        return None
    return min(rows, key=lambda row: abs((row.record_date - target).days))


# ── SyncLog ────────────────────────────────────────────────────────────────────

# ── Retirement ─────────────────────────────────────────────────────────────────

def get_retirement_account_tags() -> Dict[str, bool]:
    with Session(engine()) as session:
        rows = session.exec(select(RetirementAccountTag)).all()
        return {r.account_name: r.is_retirement for r in rows}


def upsert_retirement_account_tags(tags: Dict[str, bool]) -> None:
    with Session(engine()) as session:
        for account_name, is_retirement in tags.items():
            existing = session.get(RetirementAccountTag, account_name)
            if existing:
                existing.is_retirement = is_retirement
            else:
                session.add(RetirementAccountTag(account_name=account_name, is_retirement=is_retirement))
        session.commit()


def get_retirement_scenarios() -> List[RetirementScenario]:
    with Session(engine()) as session:
        return session.exec(
            select(RetirementScenario).order_by(RetirementScenario.updated_at.desc())
        ).all()


def create_retirement_scenario(
    name: str,
    current_age: int,
    retirement_age: int,
    max_age: int,
    monthly_contribution: int,
    phases_json: str,
    withdrawal_tax_rate: float = 0.22,
    post_retirement_equity_pct: float = 0.6,
) -> RetirementScenario:
    with Session(engine()) as session:
        scenario = RetirementScenario(
            name=name,
            current_age=current_age,
            retirement_age=retirement_age,
            max_age=max_age,
            monthly_contribution=monthly_contribution,
            phases_json=phases_json,
            withdrawal_tax_rate=withdrawal_tax_rate,
            post_retirement_equity_pct=post_retirement_equity_pct,
        )
        session.add(scenario)
        session.commit()
        session.refresh(scenario)
        return scenario


def update_retirement_scenario(
    scenario_id: int,
    name: Optional[str] = None,
    current_age: Optional[int] = None,
    retirement_age: Optional[int] = None,
    max_age: Optional[int] = None,
    monthly_contribution: Optional[int] = None,
    phases_json: Optional[str] = None,
    withdrawal_tax_rate: Optional[float] = None,
    post_retirement_equity_pct: Optional[float] = None,
) -> Optional[RetirementScenario]:
    with Session(engine()) as session:
        scenario = session.get(RetirementScenario, scenario_id)
        if not scenario:
            return None
        if name is not None:
            scenario.name = name
        if current_age is not None:
            scenario.current_age = current_age
        if retirement_age is not None:
            scenario.retirement_age = retirement_age
        if max_age is not None:
            scenario.max_age = max_age
        if monthly_contribution is not None:
            scenario.monthly_contribution = monthly_contribution
        if phases_json is not None:
            scenario.phases_json = phases_json
        if withdrawal_tax_rate is not None:
            scenario.withdrawal_tax_rate = withdrawal_tax_rate
        if post_retirement_equity_pct is not None:
            scenario.post_retirement_equity_pct = post_retirement_equity_pct
        scenario.updated_at = datetime.utcnow()
        session.commit()
        session.refresh(scenario)
        return scenario


def delete_retirement_scenario(scenario_id: int) -> bool:
    with Session(engine()) as session:
        scenario = session.get(RetirementScenario, scenario_id)
        if not scenario:
            return False
        session.delete(scenario)
        session.commit()
        return True


def get_sync_warnings() -> List[str]:
    """
    Compute warnings at read time:
      1. Per-source: holdings count drop (from most recent SyncLog per source)
      2. Cross-source: snapshot dates out of sync
    """
    warnings: List[str] = []

    with Session(engine()) as session:
        # 1. Per-source warnings from most recent SyncLog per source
        sources_logged = session.exec(select(SyncLog.source).distinct()).all()
        for source in sources_logged:
            log = session.exec(
                select(SyncLog)
                .where(SyncLog.source == source)
                .order_by(SyncLog.synced_at.desc())
            ).first()
            if log and log.warnings_json:
                warnings.extend(json.loads(log.warnings_json))

        # 2. Cross-source: latest aggregate snapshot_date per source
        all_agg = session.exec(
            select(Snapshot)
            .where(Snapshot.account_name == None)  # noqa: E711
            .order_by(Snapshot.snapshot_date.desc())
        ).all()

        latest_per_source: Dict[str, date] = {}
        for snap in all_agg:
            if snap.source not in latest_per_source:
                latest_per_source[snap.source] = snap.snapshot_date

        if len(latest_per_source) >= 2:
            max_date = max(latest_per_source.values())
            stale = [(src, d) for src, d in latest_per_source.items() if d < max_date]
            if stale:
                stale_str = "、".join(f"{src}（{d}）" for src, d in stale)
                warnings.append(f"数据不完整：{stale_str} 落后于最新同步日期 {max_date}")

    return warnings
