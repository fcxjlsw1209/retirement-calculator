from __future__ import annotations

"""
Daily market data fetcher for the Market Pulse page.

Run as a cron job (weekdays, pre-market):
  python -m backend.market_fetcher

On first run: backfills 5 years of SP500/NASDAQ price history.
Subsequent runs: appends one row per day to each table.

Data sources:
  yfinance  — ^GSPC (SP500), ^NDX (NASDAQ100), ^VIX, ^VXN, RSI from SP500 closes
  CNN       — Fear & Greed index (unofficial endpoint, graceful degradation on failure)
"""

import sys
from datetime import date, timedelta
from typing import Optional

import requests
import yfinance as yf

from backend import db

CNN_FG_URL = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata"
BACKFILL_THRESHOLD = 30   # rows below this triggers a 5Y backfill
RSI_MIN_PERIODS = 28      # need at least 2×14 points for a stable first RSI reading


class FetchError(Exception):
    pass


# ── Pure helpers ───────────────────────────────────────────────────────────────

def _compute_rsi(closes, n: int = 14) -> Optional[float]:
    """RSI(n) from a pandas Series of closing prices. Returns None if insufficient data."""
    if len(closes) < RSI_MIN_PERIODS:
        return None
    delta = closes.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(com=n - 1, min_periods=n).mean()
    avg_loss = loss.ewm(com=n - 1, min_periods=n).mean()
    rs = avg_gain / avg_loss
    rsi = 100 - (100 / (1 + rs))
    return float(rsi.iloc[-1])


def _fetch_fg() -> Optional[int]:
    """Fetch CNN Fear & Greed score. Returns None on any failure — page still works."""
    try:
        r = requests.get(
            CNN_FG_URL,
            timeout=10,
            headers={"User-Agent": "Mozilla/5.0 (compatible; Retirement Calculator/1.0)"},
        )
        r.raise_for_status()
        score = r.json()["fear_and_greed"]["score"]
        return int(round(float(score)))
    except Exception as e:
        print(f"[market_fetcher] CNN F&G fetch failed (non-fatal): {e}")
        return None


# ── Fetch from yfinance ────────────────────────────────────────────────────────

def _download(tickers: list[str], period: str):
    """Thin wrapper around yf.download with consistent settings."""
    data = yf.download(
        tickers,
        period=period,
        interval="1d",
        progress=False,
        auto_adjust=True,
    )
    return data


def _extract_close(data, ticker: str):
    """Return the Close series for a ticker from a multi-ticker download."""
    if "Close" not in data.columns.get_level_values(0):
        raise FetchError(f"No Close column in data for {ticker}")
    closes = data["Close"][ticker].dropna()
    if closes.empty:
        raise FetchError(f"Empty Close data for {ticker}")
    return closes


# ── Backfill ───────────────────────────────────────────────────────────────────

def _should_backfill() -> bool:
    return db.count_price_history() < BACKFILL_THRESHOLD


def _backfill_price_history() -> None:
    """Pull 5Y of SP500 + NASDAQ closes and upsert into price_history."""
    print("[market_fetcher] Running 5Y backfill for price_history...")
    data = _download(["^GSPC", "^NDX"], period="5y")

    sp500 = _extract_close(data, "^GSPC")
    ndx = _extract_close(data, "^NDX")

    rows = []
    for idx in sp500.index:
        d = idx.date() if hasattr(idx, "date") else idx
        if d not in ndx.index and idx not in ndx.index:
            continue
        ndx_val = float(ndx.loc[idx]) if idx in ndx.index else None
        if ndx_val is None:
            continue
        rows.append({
            "record_date": d,
            "sp500_close": float(sp500.loc[idx]),
            "ndx_close": ndx_val,
        })

    n = db.upsert_price_history(rows)
    print(f"[market_fetcher] Backfill complete: {n} rows written to price_history")


# ── Daily fetch ────────────────────────────────────────────────────────────────

def fetch_and_store() -> None:
    """
    Main entry point. Fetches market data and writes to DB.
    Backfills 5Y price history on first run (price_history empty).
    """
    if _should_backfill():
        _backfill_price_history()

    # Fetch recent price data (1mo ensures we get all missing closes even after holidays/weekends/breaks)
    print("[market_fetcher] Fetching daily market data...")
    price_data = _download(["^GSPC", "^NDX"], period="1mo")
    sp500_closes = _extract_close(price_data, "^GSPC")
    ndx_closes = _extract_close(price_data, "^NDX")

    # Upsert all downloaded days into price_history to fill any gaps
    price_rows = []
    for idx in sp500_closes.index:
        d = idx.date() if hasattr(idx, "date") else idx
        if d in ndx_closes.index or idx in ndx_closes.index:
            ndx_val = float(ndx_closes.loc[idx])
            price_rows.append({
                "record_date": d,
                "sp500_close": float(sp500_closes.loc[idx]),
                "ndx_close": ndx_val,
            })
    db.upsert_price_history(price_rows)

    latest_idx = sp500_closes.index[-1]
    today = latest_idx.date() if hasattr(latest_idx, "date") else latest_idx
    sp500_close = float(sp500_closes.iloc[-1])
    ndx_close = float(ndx_closes.iloc[-1])

    # Fetch VIX + VXN
    vol_data = _download(["^VIX", "^VXN"], period="5d")
    vix_closes = _extract_close(vol_data, "^VIX")
    vxn_closes = _extract_close(vol_data, "^VXN")
    vix = float(vix_closes.iloc[-1])
    vxn = float(vxn_closes.iloc[-1])

    # RSI(14) from 3 months of SP500 closes
    rsi_data = _download(["^GSPC"], period="3mo")
    rsi_sp500: Optional[float] = None
    try:
        sp500_3mo = _extract_close(rsi_data, "^GSPC")
        rsi_sp500 = _compute_rsi(sp500_3mo)
    except FetchError as e:
        print(f"[market_fetcher] RSI fetch failed (non-fatal): {e}")

    # CNN Fear & Greed
    fg = _fetch_fg()

    db.upsert_market_signals(today, vix=vix, vxn=vxn, fg=fg, rsi_sp500=rsi_sp500)

    rsi_str = f"{rsi_sp500:.1f}" if rsi_sp500 is not None else "N/A"
    print(
        f"[market_fetcher] Done. date={today} "
        f"SP500={sp500_close:.2f} NDX={ndx_close:.2f} "
        f"VIX={vix:.2f} VXN={vxn:.2f} "
        f"F&G={fg} RSI={rsi_str}"
    )


if __name__ == "__main__":
    try:
        fetch_and_store()
    except FetchError as e:
        print(f"[market_fetcher] FATAL: {e}", file=sys.stderr)
        sys.exit(1)
