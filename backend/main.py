from __future__ import annotations

"""
Retirement Calculator FastAPI backend.

Endpoints:
  POST /api/sync                 — trigger data refresh
  GET  /api/portfolio            — merged holdings + source status
  GET  /api/attribution          — cached AI explanation
  POST /api/auth/start           — begin Empower re-auth
  POST /api/auth/otp             — submit OTP to complete auth
  POST /api/upload/ms-statement  — manual MS PDF upload fallback
  GET  /api/cash-flows           — list cash flows for an account
  POST /api/cash-flows           — add a cash flow entry
  DELETE /api/cash-flows/{id}    — delete a cash flow entry
"""

import json
import re as _re
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Query, UploadFile, File, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from backend import db, ingest
from backend.empower_client import get_client
from backend.holding_mapper import generate_notices
from backend.market_fetcher import FetchError, fetch_and_store
from backend.market_pulse import compute_confluence
from backend.sync import run_sync, SyncResult

app = FastAPI(title="Retirement Calculator", version="0.1.0")

# CORS: allow React dev server (local dev + GCP simulation)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:5173",
        "http://localhost:5175",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _safe_fetch_and_store() -> None:
    try:
        fetch_and_store()
    except FetchError as e:
        print(f"[market_pulse] Background market refresh failed: {e}")
    except Exception as e:
        print(f"[market_pulse] Unexpected background market refresh failure: {e}")


# ── Response models ────────────────────────────────────────────────────────────

class SourceStatus(BaseModel):
    status: str
    synced_at: Optional[datetime] = None
    last_ok: Optional[datetime] = None
    error: Optional[str] = None
    rows: Optional[int] = None


class HoldingOut(BaseModel):
    ticker: Optional[str]
    asset_class: str
    holding_type: str           # 'Individual Stock' | 'US Equity Fund' | 'International Fund' | 'Bond Fund' | 'Cash' | 'Alternative' | 'Unknown'
    name: Optional[str]
    value_usd: float
    shares: Optional[float]
    gain_usd: Optional[float]   # value_usd - cost_basis (if cost_basis available)
    gain_pct: Optional[float]   # gain_usd / cost_basis
    source: str
    account_name: Optional[str]
    account_type: Optional[str]


class AssetClassSummary(BaseModel):
    value_usd: float
    weight: float


class AccountSummary(BaseModel):
    source: str
    firm_name: Optional[str]
    account_name: Optional[str]
    account_type: Optional[str]
    total_value_usd: float
    last_refreshed: Optional[datetime] = None


class PortfolioResponse(BaseModel):
    total_value_usd: float
    last_synced: Optional[datetime]
    sources: Dict[str, SourceStatus]
    holdings: List[HoldingOut]
    asset_class_summary: Dict[str, AssetClassSummary]
    accounts: List[AccountSummary]
    warnings: List[str] = []


class AttributionResponse(BaseModel):
    text: Optional[str]
    period_start: Optional[str]
    period_end: Optional[str]
    generated_at: Optional[datetime]


class SyncResponse(BaseModel):
    reauth_required: bool
    sources: Dict[str, SourceStatus]


class OTPRequest(BaseModel):
    code: str


class IngestHoldingIn(BaseModel):
    ticker: Optional[str] = None
    asset_class: str
    name: Optional[str] = None
    value_usd: float
    shares: Optional[float] = None
    cost_basis: Optional[float] = None
    account_name: Optional[str] = None
    account_type: Optional[str] = None


class IngestAccountIn(BaseModel):
    user_account_id: int
    firm_name: str
    name: str
    account_type: str
    balance: float
    last_refreshed: Optional[datetime] = None
    closed_date: Optional[date] = None


class IngestRequest(BaseModel):
    source: str  # 'empower'
    holdings: List[IngestHoldingIn]
    accounts: List[IngestAccountIn] = []


class CashFlowIn(BaseModel):
    account_name: str
    date: date
    amount_usd: float   # positive = money in, negative = money out
    note: Optional[str] = None


class CashFlowOut(BaseModel):
    id: int
    account_name: str
    date: date
    amount_usd: float
    note: Optional[str]
    created_at: datetime


class PricePoint(BaseModel):
    date: str       # YYYY-MM-DD
    sp500: float
    ndx: float


class MarketSignalsOut(BaseModel):
    vix: Optional[float]
    vxn: Optional[float]
    fg: Optional[int]
    rsi_sp500: Optional[float]
    vix_delta: Optional[float]   # vs nearest roughly-week-old row, None if unavailable
    vxn_delta: Optional[float]
    fg_delta: Optional[int]
    rsi_delta: Optional[float]
    delta_days: Optional[int]


class ConfluenceOut(BaseModel):
    override: bool
    recommendation: str
    action: str
    summary: str
    signal_labels: Dict[str, str]
    regimes: Dict[str, str]
    reasons: List[str]
    counterfactuals: List[Dict[str, Any]]


class PersonalizedNoticeOut(BaseModel):
    ticker: Optional[str]
    name: Optional[str]
    weight_pct: float
    signal: str
    signal_value: float
    signal_direction: str
    message: str
    unmapped: bool


class MarketPulseResponse(BaseModel):
    signals: MarketSignalsOut
    price_history: List[PricePoint]
    confluence: ConfluenceOut
    notices: List[PersonalizedNoticeOut]
    market_date: Optional[str]
    fetched_at: Optional[datetime]
    stale: bool                  # True if fetched_at > 36 hours ago


# ── Sync ───────────────────────────────────────────────────────────────────────

@app.post("/api/sync", response_model=SyncResponse)
async def sync(skip_empower: bool = False):
    """Trigger a data refresh."""
    result: SyncResult = await run_sync(skip_empower=skip_empower)

    sources = {"empower": _source_status(result.empower)}

    if result.reauth_required:
        return SyncResponse(reauth_required=True, sources=sources)

    return SyncResponse(reauth_required=False, sources=sources)


@app.post("/api/ingest")
def ingest_data(body: IngestRequest):
    """
    Accept pre-scraped data and write to DB.
    Used by local scraper scripts when the backend is running remotely (e.g. GCP).
    """
    holdings = [h.model_dump() for h in body.holdings]
    accounts = [a.model_dump() for a in body.accounts]

    if body.source == "empower":
        rows = ingest.ingest_empower(holdings, accounts)
    else:
        raise HTTPException(status_code=400, detail=f"Unknown source: {body.source}")

    return {"status": "ok", "source": body.source, "rows": rows}


def _source_status(s) -> SourceStatus:
    return SourceStatus(
        status=s.status,
        synced_at=s.synced_at,
        last_ok=s.last_ok,
        error=s.error,
        rows=s.rows,
    )


# ── Portfolio ──────────────────────────────────────────────────────────────────

def _get_visible_accounts(accounts: list[db.Account]) -> list[db.Account]:
    """返回用于展示的账户列表。已关闭账户（closed_date 不为 None）始终排除。"""
    return [a for a in accounts if a.closed_date is None]


@app.get("/api/portfolio", response_model=PortfolioResponse)
def get_portfolio():
    """Return merged holdings from all sources."""
    holdings = db.get_all_holdings()
    warnings = db.get_sync_warnings()

    if not holdings:
        return PortfolioResponse(
            total_value_usd=0,
            last_synced=None,
            sources={},
            holdings=[],
            asset_class_summary={},
            accounts=[],
            warnings=warnings,
        )

    db_accounts = db.get_all_accounts()
    merged = list(holdings)
    last_synced = max((h.synced_at for h in merged), default=None)

    visible_accounts = _get_visible_accounts(db_accounts)
    total_value = sum(a.balance for a in visible_accounts) if visible_accounts else sum(h.value_usd for h in merged)

    # Asset class summary
    by_class: Dict[str, float] = {}
    for h in merged:
        by_class[h.asset_class] = by_class.get(h.asset_class, 0) + h.value_usd

    summary = {
        cls: AssetClassSummary(
            value_usd=val,
            weight=val / total_value if total_value > 0 else 0,
        )
        for cls, val in sorted(by_class.items(), key=lambda x: -x[1])
    }

    # Source status
    sources_seen: Dict[str, db.Holding] = {}
    for h in holdings:
        if h.source not in sources_seen or h.synced_at > sources_seen[h.source].synced_at:
            sources_seen[h.source] = h

    source_statuses = {
        src: SourceStatus(status="ok", synced_at=h.synced_at)
        for src, h in sources_seen.items()
    }

    accounts = sorted(
        [
            AccountSummary(
                source=acct.source,
                firm_name=acct.firm_name,
                account_name=acct.name,
                account_type=acct.account_type,
                total_value_usd=acct.balance,
                last_refreshed=acct.last_refreshed,
            )
            for acct in visible_accounts
        ],
        key=lambda a: -a.total_value_usd,
    )

    return PortfolioResponse(
        total_value_usd=total_value,
        last_synced=last_synced,
        sources=source_statuses,
        warnings=warnings,
        holdings=[
            HoldingOut(
                ticker=_display_ticker(h.ticker),
                asset_class=h.asset_class,
                holding_type=_classify_holding_type(h.ticker, h.asset_class, h.name),
                name=_display_name(h.name),
                value_usd=h.value_usd,
                shares=h.shares,
                gain_usd=_gain_usd(h),
                gain_pct=_gain_pct(h),
                source=h.source,
                account_name=_display_account(h.account_name),
                account_type=h.account_type,
            )
            for h in sorted(merged, key=lambda h: -h.value_usd)
        ],
        asset_class_summary=summary,
        accounts=accounts,
    )


def _gain_usd(h: db.Holding) -> Optional[float]:
    if h.cost_basis and h.cost_basis > 0:
        return h.value_usd - h.cost_basis
    return None


def _gain_pct(h: db.Holding) -> Optional[float]:
    if h.cost_basis and h.cost_basis > 0:
        return (h.value_usd - h.cost_basis) / h.cost_basis
    return None


_TICKER_MAP: Dict[str, str] = {
    # ── Crypto ──────────────────────────────────────────────────────────────
    "BTC":   "Crypto",
    "GBTC":  "Crypto",   # Grayscale Bitcoin Trust
    "IBIT":  "Crypto",   # BlackRock Bitcoin ETF
    "ARKB":  "Crypto",   # ARK 21Shares Bitcoin ETF
    "QBTC":  "Crypto",   # 3iQ Bitcoin ETF
    "BTCC":  "Crypto",   # Purpose Bitcoin ETF
    "BTCX":  "Crypto",   # CI Bitcoin ETF
    "ETHU":  "Crypto",   # Ethereum ETF

    # ── Gold / Precious metals ───────────────────────────────────────────────
    "GLD":   "Gold",

    # ── Alternative ─────────────────────────────────────────────────────────
    "GSG":   "Alternative",

    # ── US Tech individual stocks ────────────────────────────────────────────
    "AAPL":  "US Stock - Tech",
    "MSFT":  "US Stock - Tech",
    "NVDA":  "US Stock - Tech",
    "AMD":   "US Stock - Tech",
    "AVGO":  "US Stock - Tech",
    "ORCL":  "US Stock - Tech",
    "CRM":   "US Stock - Tech",
    "INTC":  "US Stock - Tech",
    "PLTR":  "US Stock - Tech",
    "TTD":   "US Stock - Tech",
    "RBLX":  "US Stock - Tech",
    "HOOD":  "US Stock - Tech",
    "CLSK":  "US Stock - Tech",   # Bitcoin mining / tech
    "DRAM":  "US Stock - Tech",   # Dataram / memory tech

    # ── US Other individual stocks ───────────────────────────────────────────
    "XOM":   "US Stock - Other",
    "GE":    "US Stock - Other",
    "OPEN":  "US Stock - Other",  # Opendoor
    "FTHM":  "US Stock - Other",  # Fathom Holdings
    "NNDM":  "US Stock - Other",  # Nano Dimension
    "BMNR":  "US Stock - Other",
    "DXYZ":  "US Stock - Other",  # Destiny Tech100

    # ── Company-specific (RSU/ESU held as stock) ────────────────────────────
    "ROKU":  "US Stock - Tech",
    "DASH":  "US Stock - Tech",   # DoorDash
    "TSLA":  "US Stock - Tech",
    "94SX0": "US Stock - Tech",   # explicit override — CUSIP-like ticker but is a stock

    # ── US Tech funds / leveraged ────────────────────────────────────────────
    "QQQ":   "US Fund - Tech",
    "QQQM":  "US Fund - Tech",    # Mini QQQ
    "QLD":   "US Fund - Tech",    # 2× leveraged QQQ
    "MAGS":  "US Fund - Tech",    # Magnificent 7 ETF
    "ARKK":  "US Fund - Tech",    # ARK Innovation
    "JEPQ":  "US Fund - Tech",    # JPMorgan Nasdaq Equity Premium Income

    # ── US Broad funds ───────────────────────────────────────────────────────
    "VOO":   "US Fund - Broad",
    "VFIAX": "US Fund - Broad",   # Vanguard 500 Index Admiral
    "FXAIX": "US Fund - Broad",   # Fidelity 500 Index
    "VIGAX": "US Fund - Broad",   # Vanguard Growth Index Admiral
    "FCNTX": "US Fund - Broad",   # Fidelity Contrafund
    "DODGX": "US Fund - Broad",   # Dodge & Cox Stock
    "CRCL":  "US Stock - Tech",    # Circle Internet Group

    # ── US Small cap ─────────────────────────────────────────────────────────
    "IWM":   "US Fund - Small Cap",
    "VVIAX": "US Fund - Small Cap", # Vanguard Small Cap Value Admiral

    # ── International ────────────────────────────────────────────────────────
    "TSM":   "Intl Stock",
    "IEFA":  "Intl Fund",
    "BILI":  "Intl Stock",         # Bilibili (China)
    "LSPD":  "Intl Stock",         # Lightspeed (Canada)
    "GOOS":  "Intl Stock",         # Canada Goose (Canada)

    # ── Bond funds ───────────────────────────────────────────────────────────
    "AGG":   "Bond Fund",
    "TLH":   "Bond Fund",          # iShares 10-20Y Treasury
    "EDV":   "Bond Fund",          # Vanguard Extended Duration Treasury

    # ── Thematic ─────────────────────────────────────────────────────────────
    "VNQ":   "US Fund - Thematic",

    # ── US Health / other sectors ────────────────────────────────────────────
    "UNHG":  "US Stock - Other",   # 2× leveraged UnitedHealth (treated as individual stock risk)
}


def _classify_holding_type(ticker: Optional[str], asset_class: str, name: Optional[str] = None) -> str:
    if asset_class == "Cash":
        return "Cash"

    t = ticker.upper().strip() if ticker else ""
    t = t.split('.')[0]  # strip plan/grant suffixes (e.g. AAPL.eso → AAPL)
    t = t.rstrip('@#$')  # strip broker-specific suffixes (e.g. DASH@ → DASH)
    n = (name or "").upper()

    # Map lookup first — allows explicit overrides for CUSIP-like tickers
    if t in _TICKER_MAP:
        return _TICKER_MAP[t]

    # CUSIP-like (8-9 alphanumeric, mostly digits) → individual bond
    if t and len(t) >= 8 and sum(c.isdigit() for c in t) > len(t) // 2:
        return "Bond"

    def _classify_by_name(n: str, asset_class: str) -> str:
        if any(kw in n for kw in ("MONEY MARKET", "INTEREST ACCUMULATION", "STABLE VALUE", "CASH RESERVE", "RETIRE SAVINGS TRUST", "SAVINGS TRUST")):
            return "Cash"
        if any(kw in n for kw in ("TARGET DATE", "TARGET RETIRE", "RETIRE", "2050", "2055", "2060", "2065")):
            return "US Fund - Target Date"
        if any(kw in n for kw in ("GOLD", "PRECIOUS METAL")):
            return "Gold"
        if any(kw in n for kw in ("COMMODITY", "COMMODITIES", "MANAGED FUTURES", "INFRASTRUCTURE", "REAL ESTATE")):
            return "Alternative"
        # Bond check before Intl — catches "EMERGING MKTS BD ETF", "TOTAL RETURN" bond funds, etc.
        if any(kw in n for kw in ("BOND", "FIXED INCOME", " BD ", "BD ETF", "BD MKT", "TOT BD",
                                   "AGGREGATE", "TREASURY", "TREAS", "GOVT", "MORTGAGE",
                                   "HIGH YIELD", "HIGH-YIELD", "TOTAL RETURN", "CREDIT BOND")):
            return "Bond Fund"
        if asset_class == "Bond":
            return "Bond Fund"
        if any(kw in n for kw in ("EAFE", "EMERGING", "INTERNATIONAL", "INTL", "GLOBAL", "WORLD", "EM MKT", "EM MKTS")):
            return "Intl Fund"
        if any(kw in n for kw in ("RUSSELL 2000", "SMALL CAP", "SMALL-CAP")):
            return "US Fund - Small Cap"
        return "US Fund - Broad"

    # Fallback for no-ticker holdings (name-based)
    if not t:
        return _classify_by_name(n, asset_class)

    if asset_class == "Bond":
        return "Bond"

    return "Unknown"


# ── Display cleaning (raw stored in DB, cleaned here for API response) ─────────

def _display_ticker(raw_ticker: Optional[str]) -> Optional[str]:
    if not raw_ticker:
        return None
    # Strip plan/grant suffixes: GOOG.eso → GOOG
    t = raw_ticker.split('.')[0].strip()
    # Discard CUSIP-like values (8–9 alphanumeric chars, majority digits)
    if len(t) >= 8 and sum(c.isdigit() for c in t) > len(t) // 2:
        return None
    # Discard pure digit/hyphen strings (plan IDs)
    if _re.match(r'^[\d\-]+$', t):
        return None
    return t or None


def _display_name(raw_name: Optional[str]) -> Optional[str]:
    if not raw_name:
        return None
    # Discard names that look like plan/grant IDs
    if _re.match(r'^[\d\-\s]+$', raw_name.strip()):
        return None
    # Strip Unicode replacement characters (encoding artifacts, e.g. ® → \ufffd)
    name = _re.sub(r'[\ufffd\x00-\x08\x0b\x0c\x0e-\x1f]', '', raw_name).strip()
    if not name:
        return None
    # Truncate long names
    return name if len(name) <= 36 else name[:35] + '…'


def _display_account(account_name: Optional[str]) -> Optional[str]:
    if not account_name:
        return None
    if account_name == "In Multiple Accounts":
        return "Multiple Accounts"
    # Extract trailing 4-digit code: "Brokerage - Ending in 4388" → ···4388
    m = _re.search(r'(\d{4})\s*$', account_name)
    # Base = everything before "Ending in" or trailing " - "
    base = _re.split(r'\s*[-–]?\s*[Ee]nding\s+[Ii]n\b', account_name)[0]
    base = _re.sub(r'\s*[-–]\s*$', '', base)
    base = _re.sub(r'\b(Llc|Inc|Corp|Ltd|Plan|Savings|Account)\b\.?', '', base, flags=_re.I)
    base = _re.sub(r'\s+', ' ', base).strip()
    if m:
        base = base[:20].rstrip() if len(base) > 20 else base
        return f"{base} ···{m.group(1)}" if base else f"···{m.group(1)}"
    return account_name[:30] if len(account_name) > 30 else account_name


# ── Attribution ────────────────────────────────────────────────────────────────

@app.get("/api/attribution", response_model=AttributionResponse)
def get_attribution():
    """Return latest cached AI attribution explanation."""
    cached = db.get_latest_attribution()
    if cached is None:
        return AttributionResponse(
            text=None,
            period_start=None,
            period_end=None,
            generated_at=None,
        )
    return AttributionResponse(
        text=cached.attribution_text,
        period_start=cached.period_start.isoformat() if cached.period_start else None,
        period_end=cached.period_end.isoformat() if cached.period_end else None,
        generated_at=cached.generated_at,
    )


# ── Auth ───────────────────────────────────────────────────────────────────────

@app.post("/api/auth/start")
async def auth_start():
    """Initiate Empower re-auth via Playwright browser login."""
    client = get_client()
    state = await client.start_auth()
    if state == "complete":
        return {"status": "complete", "message": "Session restored."}
    if state == "needs_otp":
        return {"status": "needs_otp", "message": "OTP required."}
    raise HTTPException(status_code=500, detail="Auth failed. Check EMPOWER_EMAIL/PASSWORD in .env.")


@app.post("/api/auth/otp")
def auth_otp(body: OTPRequest):
    """Submit OTP to complete Empower auth."""
    client = get_client()
    success = client.finish_auth(body.code)
    if not success:
        raise HTTPException(status_code=400, detail="Invalid or expired OTP. Try again.")
    return {"status": "ok", "message": "Authentication successful."}


# ── Cash flows ──────────────────────────────────────────────────────────────────

@app.get("/api/cash-flows", response_model=List[CashFlowOut])
def list_cash_flows(account_name: str):
    """List all cash flows for an account, sorted by date descending."""
    flows = db.get_cash_flows(account_name)
    return [CashFlowOut(
        id=cf.id,
        account_name=cf.account_name,
        date=cf.date,
        amount_usd=cf.amount_usd,
        note=cf.note,
        created_at=cf.created_at,
    ) for cf in flows]


@app.post("/api/cash-flows", response_model=CashFlowOut)
def create_cash_flow(body: CashFlowIn):
    """Add a cash flow entry for an account."""
    cf = db.add_cash_flow(
        account_name=body.account_name,
        cf_date=body.date,
        amount_usd=body.amount_usd,
        note=body.note,
    )
    return CashFlowOut(
        id=cf.id,
        account_name=cf.account_name,
        date=cf.date,
        amount_usd=cf.amount_usd,
        note=cf.note,
        created_at=cf.created_at,
    )


class SyncLogOut(BaseModel):
    id: int
    synced_at: str      # ISO datetime string
    source: str
    holdings_count: int
    total_value_usd: float
    status: str         # 'ok' | 'warning'
    warnings: List[str]


@app.get("/api/sync-logs", response_model=List[SyncLogOut])
def list_sync_logs():
    """Return recent sync history (newest first)."""
    logs = db.get_sync_logs(limit=30)
    return [
        SyncLogOut(
            id=log.id,
            synced_at=log.synced_at.isoformat(),
            source=log.source,
            holdings_count=log.holdings_count,
            total_value_usd=log.total_value_usd,
            status=log.status,
            warnings=json.loads(log.warnings_json) if log.warnings_json else [],
        )
        for log in logs
    ]


@app.delete("/api/cash-flows/{cf_id}")
def delete_cash_flow(cf_id: int):
    """Delete a cash flow entry."""
    ok = db.delete_cash_flow(cf_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Cash flow not found.")
    return {"status": "ok"}


# ── Market Pulse ──────────────────────────────────────────────────────────────

@app.get("/api/market-pulse", response_model=MarketPulseResponse)
def get_market_pulse(background_tasks: BackgroundTasks):
    """Return market signals, price history chart data, confluence result, and personalized notices."""
    latest = db.get_latest_market_signals()
    prior = db.get_market_signals_for_delta(latest.record_date) if latest else None
    delta_days = (latest.record_date - prior.record_date).days if latest and prior else None

    def _delta_f(today_val, prior_val) -> Optional[float]:
        if today_val is None or prior_val is None:
            return None
        return round(today_val - prior_val, 2)

    def _delta_i(today_val, prior_val) -> Optional[int]:
        if today_val is None or prior_val is None:
            return None
        return today_val - prior_val

    vix = latest.vix if latest else None
    vxn = latest.vxn if latest else None
    fg = latest.fg if latest else None
    rsi = latest.rsi_sp500 if latest else None

    signals = MarketSignalsOut(
        vix=vix,
        vxn=vxn,
        fg=fg,
        rsi_sp500=rsi,
        vix_delta=_delta_f(vix, prior.vix if prior else None),
        vxn_delta=_delta_f(vxn, prior.vxn if prior else None),
        fg_delta=_delta_i(fg, prior.fg if prior else None),
        rsi_delta=_delta_f(rsi, prior.rsi_sp500 if prior else None),
        delta_days=delta_days,
    )

    price_rows = db.get_all_price_history()
    price_history = [
        PricePoint(
            date=row.record_date.isoformat(),
            sp500=row.sp500_close,
            ndx=row.ndx_close,
        )
        for row in price_rows
    ]

    confluence_result = compute_confluence(vix, vxn, fg, rsi)
    confluence = ConfluenceOut(
        override=confluence_result.override,
        recommendation=confluence_result.recommendation,
        action=confluence_result.action,
        summary=confluence_result.summary,
        signal_labels=confluence_result.signal_labels,
        regimes=confluence_result.regimes,
        reasons=confluence_result.reasons,
        counterfactuals=confluence_result.counterfactuals,
    )

    # Reuse portfolio computation for personalized notices
    portfolio = get_portfolio()
    holding_outs = portfolio.holdings
    total_value = portfolio.total_value_usd

    raw_notices = generate_notices(holding_outs, total_value, vix, vxn)
    notices = [
        PersonalizedNoticeOut(
            ticker=n.ticker,
            name=n.name,
            weight_pct=n.weight_pct,
            signal=n.signal,
            signal_value=n.signal_value,
            signal_direction=n.signal_direction,
            message=n.message,
            unmapped=n.unmapped,
        )
        for n in raw_notices
    ]

    fetched_at = latest.fetched_at if latest else None
    market_date = latest.record_date.isoformat() if latest else None
    stale = fetched_at is None or (datetime.utcnow() - fetched_at) > timedelta(hours=36)

    if stale:
        background_tasks.add_task(_safe_fetch_and_store)

    return MarketPulseResponse(
        signals=signals,
        price_history=price_history,
        confluence=confluence,
        notices=notices,
        market_date=market_date,
        fetched_at=fetched_at,
        stale=stale,
    )


# ── Portfolio history ──────────────────────────────────────────────────────────

class SnapshotPoint(BaseModel):
    date: str
    value: float


class CashFlowPoint(BaseModel):
    date: str
    amount: float
    note: Optional[str] = None


class AccountHistory(BaseModel):
    source: str
    account_name: str
    firm_name: Optional[str] = None
    account_type: Optional[str] = None
    snapshots: List[SnapshotPoint]
    cash_flows: List[CashFlowPoint]


class PortfolioHistoryResponse(BaseModel):
    accounts: List[AccountHistory]


@app.get("/api/portfolio/history", response_model=PortfolioHistoryResponse)
def get_portfolio_history(
    from_date: Optional[date] = Query(None, alias="from"),
    to_date: Optional[date] = Query(None, alias="to"),
):
    if to_date is None:
        to_date = date.today()
    if from_date is None:
        from_date = db.get_earliest_snapshot_date()
    if from_date is None:
        from_date = to_date
    if from_date > to_date:
        raise HTTPException(status_code=400, detail="from must be <= to")

    accounts = db.get_all_accounts()
    visible_accts = _get_visible_accounts(accounts)
    account_names = [a.name for a in visible_accts if a.name is not None]

    snapshots = db.get_snapshots_in_range(account_names, from_date, to_date)
    cash_flows = db.get_cash_flows_in_range(account_names, from_date, to_date)

    snaps_by_account: Dict[str, List[db.Snapshot]] = {}
    for s in snapshots:
        snaps_by_account.setdefault(s.account_name, []).append(s)

    flows_by_account: Dict[str, List[db.CashFlow]] = {}
    for cf in cash_flows:
        flows_by_account.setdefault(cf.account_name, []).append(cf)

    result = []
    for acct in visible_accts:
        if acct.name is None:
            continue
        result.append(AccountHistory(
            source=acct.source,
            account_name=acct.name,
            firm_name=acct.firm_name,
            account_type=acct.account_type,
            snapshots=[
                SnapshotPoint(date=s.snapshot_date.isoformat(), value=s.total_value_usd)
                for s in snaps_by_account.get(acct.name, [])
            ],
            cash_flows=[
                CashFlowPoint(date=cf.date.isoformat(), amount=cf.amount_usd, note=cf.note)
                for cf in flows_by_account.get(acct.name, [])
            ],
        ))

    return PortfolioHistoryResponse(accounts=result)


# ── Retirement Calculator ──────────────────────────────────────────────────────

class RetirementAccountTagsIn(BaseModel):
    tags: Dict[str, bool]


class RetirementAccountTagsResponse(BaseModel):
    tags: Dict[str, bool]


class RetirementScenarioOut(BaseModel):
    id: int
    name: str
    current_age: int
    retirement_age: int
    max_age: int
    monthly_contribution: int
    phases_json: str
    withdrawal_tax_rate: float
    post_retirement_equity_pct: float = 0.6
    created_at: str
    updated_at: str


class RetirementScenarioIn(BaseModel):
    name: str
    current_age: int
    retirement_age: int
    max_age: int
    monthly_contribution: int
    phases_json: str
    withdrawal_tax_rate: float = 0.22
    post_retirement_equity_pct: float = 0.6


class RetirementScenarioUpdateIn(BaseModel):
    name: Optional[str] = None
    current_age: Optional[int] = None
    retirement_age: Optional[int] = None
    max_age: Optional[int] = None
    monthly_contribution: Optional[int] = None
    phases_json: Optional[str] = None
    withdrawal_tax_rate: Optional[float] = None
    post_retirement_equity_pct: Optional[float] = None


def _scenario_out(s: db.RetirementScenario) -> RetirementScenarioOut:
    return RetirementScenarioOut(
        id=s.id,
        name=s.name,
        current_age=s.current_age,
        retirement_age=s.retirement_age,
        max_age=s.max_age,
        monthly_contribution=s.monthly_contribution,
        phases_json=s.phases_json,
        withdrawal_tax_rate=s.withdrawal_tax_rate,
        post_retirement_equity_pct=s.post_retirement_equity_pct,
        created_at=s.created_at.isoformat(),
        updated_at=s.updated_at.isoformat(),
    )


@app.get("/api/retirement/account-tags", response_model=RetirementAccountTagsResponse)
def get_retirement_account_tags():
    return RetirementAccountTagsResponse(tags=db.get_retirement_account_tags())


@app.put("/api/retirement/account-tags", response_model=RetirementAccountTagsResponse)
def put_retirement_account_tags(body: RetirementAccountTagsIn):
    db.upsert_retirement_account_tags(body.tags)
    return RetirementAccountTagsResponse(tags=db.get_retirement_account_tags())


@app.get("/api/retirement/scenarios", response_model=List[RetirementScenarioOut])
def list_retirement_scenarios():
    return [_scenario_out(s) for s in db.get_retirement_scenarios()]


@app.post("/api/retirement/scenarios", response_model=RetirementScenarioOut, status_code=201)
def create_retirement_scenario(body: RetirementScenarioIn):
    s = db.create_retirement_scenario(
        name=body.name,
        current_age=body.current_age,
        retirement_age=body.retirement_age,
        max_age=body.max_age,
        monthly_contribution=body.monthly_contribution,
        phases_json=body.phases_json,
        withdrawal_tax_rate=body.withdrawal_tax_rate,
        post_retirement_equity_pct=body.post_retirement_equity_pct,
    )
    return _scenario_out(s)


@app.put("/api/retirement/scenarios/{scenario_id}", response_model=RetirementScenarioOut)
def update_retirement_scenario(scenario_id: int, body: RetirementScenarioUpdateIn):
    s = db.update_retirement_scenario(
        scenario_id=scenario_id,
        name=body.name,
        current_age=body.current_age,
        retirement_age=body.retirement_age,
        max_age=body.max_age,
        monthly_contribution=body.monthly_contribution,
        phases_json=body.phases_json,
        withdrawal_tax_rate=body.withdrawal_tax_rate,
        post_retirement_equity_pct=body.post_retirement_equity_pct,
    )
    if s is None:
        raise HTTPException(status_code=404, detail="Scenario not found")
    return _scenario_out(s)


@app.delete("/api/retirement/scenarios/{scenario_id}", status_code=204)
def delete_retirement_scenario(scenario_id: int):
    if not db.delete_retirement_scenario(scenario_id):
        raise HTTPException(status_code=404, detail="Scenario not found")
